// Outline — candidate B: inverted hull.
//
// A copy of the mesh, inflated along the normals, tinted with ink and with the
// FRONT faces culled: only the border sticking out behind the original mesh stays
// visible. It is the technique of Japanese cel-shaded games and it is the one
// that gives the "brush" stroke: the thickness is in world units, so the outline
// thins out with distance exactly as a drawing in perspective would.
//
// The cost is one extra draw call per mesh. In a prototype that does not matter;
// in a real application it would, and that is precisely the trade-off a consumer has to be
// able to see before choosing it.
//
// Why not Babylon's `mesh.renderOutline`: it does the same thing, but the color
// and the thickness live on the mesh rather than on a shared material, so every
// retune is a loop over all meshes instead of one uniform. In a lab where
// thickness is the axis being tuned, that is the whole difference.

import type { Material, Scene } from '@babylonjs/core';
import { Color3, Mesh, ShaderMaterial, VertexBuffer, VertexData } from '@babylonjs/core';
import { setCelPluginOn } from './CelMaterialPlugin';
import { CEL_HULL_VERTEX_SHADER, CEL_HULL_FRAGMENT_SHADER } from './celShading.glsl';

export interface CelHullOptions {
    /** Extrusion along the normal, in world units. */
    thickness: number;
    color: Color3;
}

export const DEFAULT_CEL_HULL: CelHullOptions = {
    thickness: 0.035,
    color: new Color3(0.04, 0.03, 0.06),
};

export interface CelHullHandle {
    readonly material: ShaderMaterial;
    /** The hulls created so far — one per source mesh. */
    readonly hulls: readonly Mesh[];
    add(source: Mesh): Mesh | null;
    apply(patch: Partial<CelHullOptions>): void;
    setEnabled(on: boolean): void;
    dispose(): void;
}

/** A single hull material per scene, shared by every hull: retuning the
 *  thickness is then a single uniform instead of N materials to update. */
export function createCelHullFactory(
    scene: Scene,
    overrides: Partial<CelHullOptions> = {},
): CelHullHandle {
    const opts: CelHullOptions = { ...DEFAULT_CEL_HULL, ...overrides };

    const material = new ShaderMaterial(
        'cel-hull',
        scene,
        { vertexSource: CEL_HULL_VERTEX_SHADER, fragmentSource: CEL_HULL_FRAGMENT_SHADER },
        {
            attributes: ['position', 'normal'],
            uniforms: ['world', 'viewProjection', 'hullThickness', 'hullColor'],
        },
    );
    // The hull must show only its own BACK SIDE: the front faces have to be
    // culled, or the inflated copy would cover the original and a solid black
    // silhouette would show. `cullBackFaces = false` is Babylon's explicit lever
    // for inverting which side gets culled; `sideOrientation` is NOT enough,
    // because it gets recombined with the mesh's own and the result depends on
    // the scene's coordinate system.
    material.backFaceCulling = true;
    material.cullBackFaces = false;
    material.setFloat('hullThickness', opts.thickness);
    material.setColor3('hullColor', opts.color);

    const hulls: Mesh[] = [];

    return {
        material,
        hulls,
        add(source) {
            const hull = source.clone(`${source.name}-hull`, source.parent, true);
            if (!hull) return null;
            hull.material = material;
            // The hull is pure decoration: no picking, no shadows, no
            // contribution to the bounds used by the source's culling.
            hull.isPickable = false;
            hull.receiveShadows = false;
            hull.doNotSyncBoundingInfo = true;
            hulls.push(hull);
            return hull;
        },
        apply(patch) {
            Object.assign(opts, patch);
            if (patch.thickness !== undefined) material.setFloat('hullThickness', opts.thickness);
            if (patch.color) material.setColor3('hullColor', opts.color);
        },
        setEnabled(on) {
            for (const h of hulls) h.setEnabled(on);
        },
        dispose() {
            for (const h of hulls) h.dispose();
            hulls.length = 0;
            material.dispose();
        },
    };
}

// ── Hull BAKED INTO THE GEOMETRY: zero draw calls ──────────────────────────
//
// The outline's third incarnation, after the post-process and the
// `renderOutline` hull. Both measured on the mid-tier reference device (a dense
// outdoor scene, 112k verts, device ~38°C): the post-process costs ~20 fps of
// fixed tax that no lever reduces (five tried); the per-mesh hull costs ~0.13
// fps per draw call, and over a whole scenery that is +127 DC = −14 fps. The
// fps↔DC relation is linear and the VERTICES, by contrast, are free (removing
// 35k verts moves nothing): the frame is submission-bound, not raster-bound.
//
// Hence the move: attach the hull's triangles TO THE SAME mesh. Extruded along
// the normal, wound the other way, tinted with ink in the vertices — backface
// culling shows only the border that sticks out, exactly like the classic hull,
// but inside the draw call the mesh already pays for. The cost is raster and
// memory (+100% of the piece's triangles), i.e. the currency that is worth
// nothing on this frame.
//
// ⚠️ The extrusion normals have to be SMOOTHED by position, not taken from the
// mesh: cel models are flat-shaded, i.e. they have vertices split per face with
// diverging normals — extruding along those splits the hull open at every hard
// edge (it is the tearing for which candidate B had been discarded). Averaging
// the normals of all vertices sharing a position closes the hull by construction:
// it is the classic fix, and here it is also what makes the stroke CLEAN where
// the per-mesh hull fell apart.


/** The meshes already baked: baking is irreversible on the live mesh (it comes
 *  off only by rebuilding the model), so it has to be done exactly once. */
const bakedHulls = new WeakSet<object>();

/** The REFUSED meshes, and remembering them is mandatory: the production caller
 *  retries every frame (meshes are born empty and get baked on the first frame
 *  with geometry), and without this set every refusal — updatable buffer,
 *  non-Standard material, open components — would redo the ENTIRE ANALYSIS
 *  (clusters, union-find, volumes) sixty times a second on a world that is
 *  already CPU-bound. All the refusal reasons are permanent by construction:
 *  updatable is a declaration, the material is assigned at birth, the topology
 *  does not change without rebuilding the mesh (and a rebuilt mesh is a new
 *  object). */
const bakeRejected = new WeakSet<object>();

/** CULLING-ON variants of the shared materials, one per source material (key:
 *  uniqueId) — not one per mesh, or the bind cost would grow with the scene
 *  instead of with the number of materials.
 *
 *  ⚠️ Why they are needed: a consumer's material library may well build the
 *  shared materials with `backFaceCulling = false` (two-sided foliage demands
 *  it), and without culling the baked hull draws the FRONT faces too — the
 *  object comes out covered in ink — the whole scene reads as charred. The hull
 *  lives off culling: its faces point inwards on purpose.
 *
 *  On a CLOSED volume (the only kind of mesh this baking accepts) turning culling
 *  on does not change a single pixel of the model: the back faces of a closed
 *  solid are never seen. It only changes the hull, which finally shows the border
 *  and hides the rest.
 *
 *  The variant does NOT go through the MaterialLibrary: it is an off-the-books
 *  clone, it lives as long as the scene and is released with its dispose. The cel
 *  plugin has to be switched back on by hand on the clone — the global switch-on
 *  iterates the materials ALIVE at call time, and the clone is born after. */
const hullMatVariants = new Map<number, Material>();

function cullingOnVariant(mat: Material): Material | null {
    const hit = hullMatVariants.get(mat.uniqueId);
    if (hit) return hit;
    const cloneFn = (mat as Material & { clone?: (name: string) => Material | null }).clone;
    if (typeof cloneFn !== 'function') return null;
    const clone = cloneFn.call(mat, `${mat.name}-hullcull`);
    if (!clone) return null;
    clone.backFaceCulling = true;
    // ⚠️ INVERTED orientation with respect to the default. The cel models were
    // born, and have always been looked at, under culling off, where the winding
    // does not matter: measured with it on, their faces read as BACK by Babylon's
    // convention — the solid disappears and what is left is the inside of the
    // hull, i.e. a scene of ink silhouettes. The right direction is declared
    // here, on the variant material, and the approved models are left alone.
    clone.sideOrientation = 0; // Material.ClockWiseSideOrientation
    setCelPluginOn(clone, true);
    hullMatVariants.set(mat.uniqueId, clone);
    return clone;
}

/** The mesh already has the hull baked in. Needed by the caller that sweeps per
 *  frame: «already baked» and «refused» both answer false to baking, but only the
 *  second has to fall back to the per-mesh hull. */
export function isCelHullBaked(mesh: object): boolean {
    return bakedHulls.has(mesh);
}

/** Attaches the ink hull to the mesh's geometry. Returns false if the mesh is not
 *  bakeable (no geometry of its own, already baked, or lacking the
 *  positions+indices set). A refusal is PERMANENT (see `bakeRejected`). */
/** The BODY's extent, i.e. the geometry as it was before the hull existed.
 *
 *  ⚠️ IT EXISTS BECAUSE BAKING CHANGES THE MEASUREMENT, NOT JUST THE DRAWING. The
 *  hull is a copy of the mesh inflated along the normals and baked **into the same
 *  geometry**: after `bakeCelHullIntoMesh` the mesh has twice the vertices and a
 *  non-uniformly larger box (measured on a log-shaped mesh,
 *  `1.388/0.550/0.547` → `1.423/0.579/0.571`). Anyone who **derives** a
 *  measurement from the mesh — a hitbox, a rolling radius, a lethal half-width —
 *  is, after baking, also measuring the outline's ink, and has no way of noticing:
 *  the mesh is the same, the key is the same, and the number is simply a different
 *  one.
 *
 *  The cure is not that every factory remembers to measure first (a hand-made copy
 *  diverges at the first lapse of attention): it is that **the true measurement
 *  stays available** after baking, to whoever asks for it. Whoever has not baked
 *  finds nothing and reads the mesh, which for them is still the truth.
 *
 *  The registry is a `WeakMap`: it does not keep meshes alive, and a mesh rebuilt
 *  with the same key starts over clean. */
const bodyBoxes = new WeakMap<Mesh, { min: readonly [number, number, number]; max: readonly [number, number, number] }>();

/** The body's LOCAL extent, if this mesh has the hull baked in. `null` for every
 *  other mesh — which is the right answer: there the mesh's box is already the
 *  geometry. */
export function celBodyBoxOf(
    mesh: Mesh,
): { min: readonly [number, number, number]; max: readonly [number, number, number] } | null {
    return bodyBoxes.get(mesh) ?? null;
}

export function bakeCelHullIntoMesh(
    mesh: Mesh, width: number, color: Color3,
): boolean {
    if (bakedHulls.has(mesh) || bakeRejected.has(mesh)) return false;
    const ok = tryBakeCelHull(mesh, width, color);
    if (ok) bakedHulls.add(mesh);
    // A still EMPTY mesh is not a refusal: it is a mesh not yet born (the pool
    // fills it later). Only a no on real geometry is permanent.
    else if (mesh.getTotalVertices() > 0) bakeRejected.add(mesh);
    return ok;
}

function tryBakeCelHull(
    mesh: Mesh, width: number, color: Color3,
): boolean {
    // ⚠️ Meshes with UPDATABLE buffers are not baked. An updatable buffer is the
    // declaration that someone rewrites it at runtime — a ground tile repainting
    // its colors when the scene's palette changes, a surface resampling its
    // heights — and baking would replace it with a longer static one: the
    // subsequent rewrite would become a silent no-op, i.e. the PREVIOUS scene's
    // floor left on screen. It is the same class of defect already paid for on
    // tile keep-warm.
    const colorBuf = mesh.getVertexBuffer(VertexBuffer.ColorKind);
    const posBuf = mesh.getVertexBuffer(VertexBuffer.PositionKind);
    if (colorBuf?.isUpdatable() || posBuf?.isUpdatable()) return false;
    // Cel path only (StandardMaterial): the hull needs the culling-on variant,
    // and cloning a NON-cel material out from under the system that animates it
    // (a PBR skin that updates ITS reference every frame: the mesh would render
    // the clone while the skin writes the original) is a silent defect
    // already lying in wait. The non-Standard heroes keep the classic per-mesh
    // hull, which does not touch the material.
    if (mesh.material?.getClassName() !== 'StandardMaterial') return false;
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    const indices = mesh.getIndices();
    if (!positions || !indices || indices.length === 0) return false;
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind);
    if (!normals) return false;
    const colors = mesh.getVerticesData(VertexBuffer.ColorKind);
    const uvs = mesh.getVerticesData(VertexBuffer.UVKind);
    const count = positions.length / 3;

    // Smoothed normals: averaged by POSITION (key quantized to a tenth of a
    // millimeter — the flat-shaded copies coincide exactly, the quantization only
    // exists to make the float comparison honest).
    const clusters = new Map<string, [number, number, number]>();
    for (let v = 0; v < count; v++) {
        const k = `${Math.round((positions[v * 3] ?? 0) * 1e4)},${Math.round((positions[v * 3 + 1] ?? 0) * 1e4)},${Math.round((positions[v * 3 + 2] ?? 0) * 1e4)}`;
        const acc = clusters.get(k);
        if (acc) {
            acc[0] += normals[v * 3] ?? 0; acc[1] += normals[v * 3 + 1] ?? 0; acc[2] += normals[v * 3 + 2] ?? 0;
        } else {
            clusters.set(k, [normals[v * 3] ?? 0, normals[v * 3 + 1] ?? 0, normals[v * 3 + 2] ?? 0]);
        }
    }

    // ⚠️ The inverted hull only works for CLOSED VOLUMES, and this is the guard
    // that says so. On a PLANE (blade of grass, leaf, petal — much of any
    // stylized flora) the two sides have coincident vertices with opposite
    // normals: the average cancels out, the extrusion degenerates and the hull
    // comes out coplanar with the face — black z-fighting over the whole piece.
    // If a significant share of the clusters is degenerate, the
    // mesh is not a volume and does not get baked: better no stroke at all than a
    // stroke that devours the model.
    let degenerate = 0;
    for (const n of clusters.values()) {
        if (n[0] * n[0] + n[1] * n[1] + n[2] * n[2] < 0.25) degenerate++;
    }
    if (degenerate > clusters.size * 0.05) return false;

    // ── TWO PATHS, and the difference is who guarantees the winding ────────
    //
    // 1. Material with culling ALREADY ON: the model was looked at and approved
    //    exactly like that, so the winding is proven by the screen. The hull is
    //    emitted as the pure reverse of the authored indices and NOTHING else is
    //    touched. ⚠️ Here normalization is not merely useless: it is HARMFUL —
    //    tried, it blackened every such mesh, because the petals
    //    are open discs (signed volume ≈ 0, sign meaningless) and the "canonical"
    //    flip broke a direction that was already right.
    //
    // 2. Material with culling OFF: the winding has never been seen, and the
    //    builders do not agree (Babylon's primitives one way, the custom swept
    //    solids the other; MERGES mix them inside the same mesh). Here it is
    //    normalized PER CONNECTED COMPONENT (union-find over position clusters,
    //    signed volume per component) — and rewriting the indices is legitimate
    //    because under culling off the direction is invisible by definition:
    //    the sample application and the visual-regression tests do not change by
    //    a pixel. But it only holds IF every component really is closed: an open
    //    component has no outside, and baking it with culling on would mean
    //    making one of its sides disappear. If there is one, the mesh is not
    //    baked.
    const nativeCulling = mesh.material?.backFaceCulling === true;

    const clusterKeys = [...clusters.keys()];
    const clusterIndex = new Map<string, number>();
    clusterKeys.forEach((k, i) => clusterIndex.set(k, i));
    const keyOf = (v: number): number => {
        const k = `${Math.round((positions[v * 3] ?? 0) * 1e4)},${Math.round((positions[v * 3 + 1] ?? 0) * 1e4)},${Math.round((positions[v * 3 + 2] ?? 0) * 1e4)}`;
        return clusterIndex.get(k) ?? 0;
    };
    const parent = new Int32Array(clusterKeys.length);
    for (let i = 0; i < parent.length; i++) parent[i] = i;
    const find = (x: number): number => {
        let r = x;
        while (parent[r] !== r) r = parent[r] ?? r;
        while (parent[x] !== r) { const nxt = parent[x] ?? r; parent[x] = r; x = nxt; }
        return r;
    };
    const union = (a: number, b: number): void => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    const faceCluster = new Int32Array(indices.length / 3);
    for (let i = 0; i < indices.length; i += 3) {
        const ca = keyOf(indices[i] ?? 0), cb = keyOf(indices[i + 1] ?? 0), cc = keyOf(indices[i + 2] ?? 0);
        union(ca, cb); union(cb, cc);
        faceCluster[i / 3] = ca;
    }
    const vol6ByRoot = new Map<number, number>();
    for (let i = 0; i < indices.length; i += 3) {
        const a = (indices[i] ?? 0) * 3, b = (indices[i + 1] ?? 0) * 3, c = (indices[i + 2] ?? 0) * 3;
        const ax = positions[a] ?? 0, ay = positions[a + 1] ?? 0, az = positions[a + 2] ?? 0;
        const bx = positions[b] ?? 0, by = positions[b + 1] ?? 0, bz = positions[b + 2] ?? 0;
        const cx = positions[c] ?? 0, cy = positions[c + 1] ?? 0, cz = positions[c + 2] ?? 0;
        const t = ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
        const r = find(faceCluster[i / 3] ?? 0);
        vol6ByRoot.set(r, (vol6ByRoot.get(r) ?? 0) + t);
    }
    // ── OPEN components: the hull is NOT emitted, on either path ───────────
    //
    // The yardstick is the component's area^1.5: a real volume grows with the
    // cube, a disc stays hugging zero. And the rule is not caution, it is geometry
    // — on an open surface the hull's back side becomes visible EXACTLY where the
    // original is culled: measured on screen on open, disc-like flower meshes,
    // the petals facing away from the camera disappeared and their ink hulls
    // showed up in their place — solid black shapes. Open components keep the
    // material's rim; the hull only goes where there is an outside.
    const areaByRoot = new Map<number, number>();
    for (let i = 0; i < indices.length; i += 3) {
        const a = (indices[i] ?? 0) * 3, bI = (indices[i + 1] ?? 0) * 3, c = (indices[i + 2] ?? 0) * 3;
        const ux = (positions[bI] ?? 0) - (positions[a] ?? 0), uy = (positions[bI + 1] ?? 0) - (positions[a + 1] ?? 0), uz = (positions[bI + 2] ?? 0) - (positions[a + 2] ?? 0);
        const vx = (positions[c] ?? 0) - (positions[a] ?? 0), vy = (positions[c + 1] ?? 0) - (positions[a + 1] ?? 0), vz = (positions[c + 2] ?? 0) - (positions[a + 2] ?? 0);
        const cx2 = uy * vz - uz * vy, cy2 = uz * vx - ux * vz, cz2 = ux * vy - uy * vx;
        const r = find(faceCluster[i / 3] ?? 0);
        areaByRoot.set(r, (areaByRoot.get(r) ?? 0) + Math.hypot(cx2, cy2, cz2) * 0.5);
    }
    // ── WINDING consistency per component ──────────────────────────────────
    //
    // The volume test is not enough, and the defect paid for on screen was a set
    // of meshes rendering SOLID BLACK: a component can pass |vol|/area^1.5 and
    // still be wound in MIXED directions (a concave cavity modeled by flipping
    // faces — legitimate authoring, the body renders identically). But the hull is the
    // REVERSE of the indices: where the author flipped, the reverse faces the
    // camera, and that piece comes out covered in ink.
    //
    // The honest yardstick is topological: in a closed, consistently wound solid
    // every edge (by POSITION, i.e. by cluster) appears EXACTLY twice, in the two
    // opposite directions. A doubled direction = mixed winding; a direction with
    // no opposite = open border. In both cases the component gets no hull —
    // better no ink stroke than a black mesh. Collapsed edges (a==b, degenerate
    // faces) are neutral: their face is invisible either way.
    const EDGE_K = 1 << 21; // cluster id < 2^21 ⇒ key a*2^21+b within safe integers
    const dirEdges = new Map<number, number>();
    const edgeOf = (a: number, b: number): number => a * EDGE_K + b;
    for (let i = 0; i < indices.length; i += 3) {
        const ca = keyOf(indices[i] ?? 0), cb = keyOf(indices[i + 1] ?? 0), cc = keyOf(indices[i + 2] ?? 0);
        for (const [a, b] of [[ca, cb], [cb, cc], [cc, ca]] as const) {
            if (a === b) continue;
            const k = edgeOf(a, b);
            dirEdges.set(k, (dirEdges.get(k) ?? 0) + 1);
        }
    }
    const consistentRoot = new Map<number, boolean>();
    for (let i = 0; i < indices.length; i += 3) {
        const root = find(faceCluster[i / 3] ?? 0);
        if (consistentRoot.get(root) === false) continue;
        const ca = keyOf(indices[i] ?? 0), cb = keyOf(indices[i + 1] ?? 0), cc = keyOf(indices[i + 2] ?? 0);
        let ok = true;
        for (const [from, to] of [[ca, cb], [cb, cc], [cc, ca]] as const) {
            if (from === to) continue;
            if (dirEdges.get(edgeOf(from, to)) !== 1 || dirEdges.get(edgeOf(to, from)) !== 1) { ok = false; break; }
        }
        consistentRoot.set(root, (consistentRoot.get(root) ?? true) && ok);
    }
    const closedRoot = new Map<number, boolean>();
    for (const [root, area] of areaByRoot) {
        const v = Math.abs(vol6ByRoot.get(root) ?? 0) / 6;
        closedRoot.set(root,
            v >= Math.pow(area, 1.5) * 0.01 && consistentRoot.get(root) === true);
    }
    const faceClosed = (faceIdx: number): boolean =>
        closedRoot.get(find(faceCluster[faceIdx] ?? 0)) === true;
    // The CLONE path (culling off at the source): open components are today seen
    // from BOTH sides, and the culling variant would cut one of them away — here
    // an open component does not degrade the hull, it disqualifies the mesh.
    if (!nativeCulling) {
        for (const closed of closedRoot.values()) {
            if (!closed) return false;
        }
    }
    // If no component is closed there is nothing to outline.
    let anyClosed = false;
    for (const closed of closedRoot.values()) { if (closed) { anyClosed = true; break; } }
    if (!anyClosed) return false;

    // The canonical direction is that of Babylon's primitives (a primitive-built
    // mesh seen rendering RIGHT under the variant): signed volume NEGATIVE in
    // the engine's left-handed system. With native culling nothing is EVER flipped
    // (see above): the authored winding is the truth.
    const flipFace = (faceIdx: number): boolean =>
        !nativeCulling && (vol6ByRoot.get(find(faceCluster[faceIdx] ?? 0)) ?? 0) > 0;

    // ⚠️ The HULL's direction, by contrast, is decided PER COMPONENT, and it is
    // not «the author's reverse». Meshes rendering solid black paid for that on
    // screen: closed, consistent components — and wound with POSITIVE volume,
    // i.e. the inverse of the primitives. On a THIN piece the inversion is
    // invisible (under culling you look at the inside of the far wall, which
    // for a lamina coincides with the outside of the near one), so the model
    // had been approved that way and «proven by the screen» proved nothing
    // about the direction. But the reverse of an inverted winding is
    // FRONT-FACING: the hull was covering the mesh in ink. The right rule: the
    // hull is ALWAYS emitted in positive orientation — the reverse of the canon —
    // whatever the body's authored direction. For canonical components that is
    // the reverse; for inverted ones it is the authored direction itself; in
    // both cases culling shows only what sticks out past the silhouette.
    const facePositive = (faceIdx: number): boolean =>
        (vol6ByRoot.get(find(faceCluster[faceIdx] ?? 0)) ?? 0) > 0;

    // ⚠️ And with an inverted winding the NORMALS are inverted too: the builders
    // derive them from the faces, so on those components they point INWARDS and an
    // extrusion «along the normal» would deflate the hull — which then ends up in
    // front of the visible wall and covers it in ink (the black petals left over
    // after the direction fix). The hull must always INFLATE: the extrusion
    // direction is decided per component, from the sign of the dot product between
    // the smoothed normal and the radius from the centroid.
    const centroid = new Map<number, [number, number, number, number]>();
    for (let v = 0; v < count; v++) {
        const r = find(keyOf(v));
        const acc = centroid.get(r);
        const x = positions[v * 3] ?? 0, y = positions[v * 3 + 1] ?? 0, z = positions[v * 3 + 2] ?? 0;
        if (acc) { acc[0] += x; acc[1] += y; acc[2] += z; acc[3]++; }
        else centroid.set(r, [x, y, z, 1]);
    }
    const outwardDot = new Map<number, number>();
    for (let v = 0; v < count; v++) {
        const r = find(keyOf(v));
        const c = centroid.get(r);
        if (!c) continue;
        const k = `${Math.round((positions[v * 3] ?? 0) * 1e4)},${Math.round((positions[v * 3 + 1] ?? 0) * 1e4)},${Math.round((positions[v * 3 + 2] ?? 0) * 1e4)}`;
        const n = clusters.get(k);
        if (!n) continue;
        const dx = (positions[v * 3] ?? 0) - c[0] / c[3];
        const dy = (positions[v * 3 + 1] ?? 0) - c[1] / c[3];
        const dz = (positions[v * 3 + 2] ?? 0) - c[2] / c[3];
        outwardDot.set(r, (outwardDot.get(r) ?? 0) + n[0] * dx + n[1] * dy + n[2] * dz);
    }
    const extrudeSign = (clusterRoot: number): number =>
        (outwardDot.get(clusterRoot) ?? 0) >= 0 ? 1 : -1;

    // ── LOCAL THICKNESS, and why the hull cannot be absolute ───────────────
    //
    // ⚠️ THE DEFECT THAT FORCED THIS BLOCK, measured in a consumer scene on 2026-08-18.
    // The hull was `width` wide everywhere, and a tuft of thin-bladed grass
    // (1.07 × 0.46 m of extent, blades a few millimeters thick) came out as a FAT
    // BLACK HOOK: the blade is thinner than its own hull, so the hull does not
    // outline it — it replaces it. On the frame those arcs measured luminance **3**
    // against sand at 203, while the darkest of that level's seventeen species, in
    // albedo, sits at 97. An albedo of 97 does not drop to 3 through shading: that
    // black was painted by the hull. Proof: raising the switch-on threshold moved
    // the near-black pixels from 1.62% to 0.30%.
    //
    // ⚠️ And the switch-on criterion could not see it: `minDiagonal` reads the
    // EXTENT, which on an arching plant says how wide it is, not how thick. The
    // quantity that matters is the RATIO between the stroke's width and the
    // thickness of the piece it has to outline — and thickness is local, not a
    // property of the mesh: a tuft merged into a single master has a large bounding
    // box in all three directions while being made of blades.
    //
    // So thickness is measured VERTEX BY VERTEX, and geometrically: from the point
    // we walk BACKWARDS along the smoothed normal and look for the opposite
    // surface, i.e. a nearby cluster whose normal faces the other way. The distance
    // at which it is found is the thickness there. The hull takes
    // `min(width, SHELL_OF_THICKNESS · thickness)`: on a boulder nothing changes
    // (the opposite wall is very far away), on a blade the hull thins out with it
    // and stays an outline instead of becoming the object.
    //
    // Cost: a hash grid over the clusters, cells as wide as the search radius,
    // twenty-seven cells inspected per vertex. This is BAKING work, once per
    // master, not per frame.
    const SHELL_OF_THICKNESS = 0.45;
    const cellSize = Math.max(width * 2, 1e-4);
    const cx3 = new Float64Array(clusterKeys.length);
    const cy3 = new Float64Array(clusterKeys.length);
    const cz3 = new Float64Array(clusterKeys.length);
    const nx3 = new Float64Array(clusterKeys.length);
    const ny3 = new Float64Array(clusterKeys.length);
    const nz3 = new Float64Array(clusterKeys.length);
    clusterKeys.forEach((k, i) => {
        const parts = k.split(',');
        cx3[i] = Number(parts[0]) / 1e4;
        cy3[i] = Number(parts[1]) / 1e4;
        cz3[i] = Number(parts[2]) / 1e4;
        const n = clusters.get(k) ?? [0, 1, 0];
        const len = Math.hypot(n[0], n[1], n[2]) || 1;
        nx3[i] = n[0] / len; ny3[i] = n[1] / len; nz3[i] = n[2] / len;
    });
    const grid = new Map<string, number[]>();
    const cellKey = (x: number, y: number, z: number): string =>
        `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)},${Math.floor(z / cellSize)}`;
    for (let i = 0; i < clusterKeys.length; i++) {
        const k = cellKey(cx3[i] ?? 0, cy3[i] ?? 0, cz3[i] ?? 0);
        const bucket = grid.get(k);
        if (bucket) bucket.push(i); else grid.set(k, [i]);
    }
    /** Hull width in this cluster: full, or as much as the local thickness
     *  allows. */
    const hullWidthAt = new Float64Array(clusterKeys.length).fill(width);
    const reach = cellSize;
    for (let i = 0; i < clusterKeys.length; i++) {
        const px = cx3[i] ?? 0, py = cy3[i] ?? 0, pz = cz3[i] ?? 0;
        const ni = nx3[i] ?? 0, nj = ny3[i] ?? 0, nk = nz3[i] ?? 0;
        // A degenerate normal (a lamina with two coincident faces) gives no
        // direction to search in: that cluster keeps the full width, and if there
        // are many of them the mesh has already been rejected by the guard above.
        if (ni * ni + nj * nj + nk * nk < 0.25) continue;
        let best = Infinity;
        const gx = Math.floor(px / cellSize), gy = Math.floor(py / cellSize), gz = Math.floor(pz / cellSize);
        for (let ax = -1; ax <= 1; ax++) for (let ay = -1; ay <= 1; ay++) for (let az = -1; az <= 1; az++) {
            const bucket = grid.get(`${gx + ax},${gy + ay},${gz + az}`);
            if (!bucket) continue;
            for (const j of bucket) {
                if (j === i) continue;
                // The OPPOSITE surface faces the other way.
                if ((nx3[j] ?? 0) * ni + (ny3[j] ?? 0) * nj + (nz3[j] ?? 0) * nk > -0.3) continue;
                const dx = (cx3[j] ?? 0) - px, dy = (cy3[j] ?? 0) - py, dz = (cz3[j] ?? 0) - pz;
                // …and lies BEHIND, i.e. in the direction in which the piece has thickness.
                const along = dx * ni + dy * nj + dz * nk;
                if (along >= 0) continue;
                const t = -along;
                if (t > reach) continue;
                // It has to be the face straight ahead, not a sideways neighbor:
                // the perpendicular offset stays within half a width.
                const ox = dx - along * ni, oy = dy - along * nj, oz = dz - along * nk;
                if (ox * ox + oy * oy + oz * oz > width * width * 0.25) continue;
                if (t < best) best = t;
            }
        }
        if (best < Infinity) hullWidthAt[i] = Math.min(width, best * SHELL_OF_THICKNESS);
    }

    const newPos = new Float32Array(count * 6);
    newPos.set(positions, 0);
    const newNor = new Float32Array(count * 6);
    newNor.set(normals, 0);
    const newCol = new Float32Array(count * 8);
    if (colors) newCol.set(colors, 0);
    else for (let v = 0; v < count; v++) { newCol[v * 4] = 1; newCol[v * 4 + 1] = 1; newCol[v * 4 + 2] = 1; newCol[v * 4 + 3] = 1; }
    const newUv = uvs ? new Float32Array(count * 4) : null;
    if (newUv && uvs) {
        newUv.set(uvs);
        newUv.copyWithin(uvs.length, 0, uvs.length);
    }

    for (let v = 0; v < count; v++) {
        const k = `${Math.round((positions[v * 3] ?? 0) * 1e4)},${Math.round((positions[v * 3 + 1] ?? 0) * 1e4)},${Math.round((positions[v * 3 + 2] ?? 0) * 1e4)}`;
        const n = clusters.get(k) ?? [0, 1, 0];
        const ci = clusterIndex.get(k) ?? 0;
        const w = (hullWidthAt[ci] ?? width) * extrudeSign(find(ci));
        const len = Math.hypot(n[0], n[1], n[2]) || 1;
        const o = (count + v) * 3;
        newPos[o] = (positions[v * 3] ?? 0) + (n[0] / len) * w;
        newPos[o + 1] = (positions[v * 3 + 1] ?? 0) + (n[1] / len) * w;
        newPos[o + 2] = (positions[v * 3 + 2] ?? 0) + (n[2] / len) * w;
        // Inverted normal: the hull faces inwards, and under cel its band comes
        // out dark anyway — the ink is in the colors.
        newNor[o] = -(normals[v * 3] ?? 0); newNor[o + 1] = -(normals[v * 3 + 1] ?? 0); newNor[o + 2] = -(normals[v * 3 + 2] ?? 0);
        const c = (count + v) * 4;
        newCol[c] = color.r; newCol[c + 1] = color.g; newCol[c + 2] = color.b; newCol[c + 3] = 1;
    }

    // Indices: the whole body, hull ONLY on the faces of closed components (see
    // above).
    const hullIdx: number[] = [];
    const bodyIdx = new Uint32Array(indices.length);
    for (let i = 0; i < indices.length; i += 3) {
        const i0 = indices[i] ?? 0, i1 = indices[i + 1] ?? 0, i2 = indices[i + 2] ?? 0;
        const flip = flipFace(i / 3);
        if (flip) { bodyIdx[i] = i0; bodyIdx[i + 1] = i2; bodyIdx[i + 2] = i1; }
        else { bodyIdx[i] = i0; bodyIdx[i + 1] = i1; bodyIdx[i + 2] = i2; }
        if (!faceClosed(i / 3)) continue;
        // Hull ALWAYS in positive orientation (see `facePositive`): culling keeps
        // only what sticks out past the silhouette.
        if (facePositive(i / 3)) hullIdx.push(count + i0, count + i1, count + i2);
        else hullIdx.push(count + i0, count + i2, count + i1);
    }
    const newIdx = new Uint32Array(bodyIdx.length + hullIdx.length);
    newIdx.set(bodyIdx, 0);
    newIdx.set(hullIdx, bodyIdx.length);

    // The material BEFORE the geometry: if the variant cannot be built the mesh
    // stays as it was, with no hull — never a half-done bake.
    const variant = mesh.material && !mesh.material.backFaceCulling
        ? cullingOnVariant(mesh.material)
        : mesh.material;
    if (!variant) return false;

    // The body's measurement is taken NOW, which is the last instant at which the
    // geometry is still only the model: `newPos` already holds the inflated copy,
    // and after `applyToMesh` the mesh's box no longer tells the two halves
    // apart.
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let v = 0; v < count; v++) {
        const x = positions[v * 3] ?? 0, y = positions[v * 3 + 1] ?? 0, z = positions[v * 3 + 2] ?? 0;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    bodyBoxes.set(mesh, { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] });

    const data = new VertexData();
    data.positions = newPos;
    data.indices = newIdx;
    data.normals = newNor;
    data.colors = newCol;
    if (newUv) data.uvs = newUv;
    data.applyToMesh(mesh, false);
    // ⚠️ THE black of merged meshes, found with an isolated repro (2026-08-08).
    // `mergeFaceted` goes through `convertToFlatShadedMesh`, which in Babylon is
    // `_convertToUnIndexedMesh(true)`: the mesh comes out marked UNINDEXED and the
    // draw IGNORES the indices — it draws the vertex array in order. With the
    // vertices doubled by baking, the array also contains the ink copy, which is
    // therefore drawn as FRONT faces on top of the body: that is the fully
    // inked scene, and it is why removing the hull's indices changed nothing (nobody
    // was reading them) while re-applying identical buffers was perfect (the raw
    // array was the model). From here on the mesh draws FROM THE INDICES: for a
    // flat-shaded mesh the vertices are all unique already, so switching to
    // indexed does not change a pixel of the body — it only switches the hull
    // on.
    if (mesh.isUnIndexed) mesh.isUnIndexed = false;
    mesh.material = variant;
    return true;
}
