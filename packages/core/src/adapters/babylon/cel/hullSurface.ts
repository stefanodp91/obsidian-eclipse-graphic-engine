// Bake-time ray queries on each connected component. No scene objects or GPU work.
type Data = ArrayLike<number>;
type Vec = readonly [
    number,
    number,
    number
];
interface Node {
    min: Vec;
    max: Vec;
    faces: number[];
    left?: Node;
    right?: Node;
}
/** Returns the first opposite surface distance along an inward ray, or Infinity.
 * Components are indexed independently: another solid can never supply a wall. */
export function createHullSurfaceQuery(positions: Data, indices: Data, roots: Int32Array) {
    const readPoint = (face: number, corner: number): Vec => {
        const i = (indices[face * 3 + corner] ?? 0) * 3;
        return [positions[i] ?? 0, positions[i + 1] ?? 0, positions[i + 2] ?? 0];
    };
    const triangles = Array.from({ length: roots.length }, (_, face) => [readPoint(face, 0), readPoint(face, 1), readPoint(face, 2)] as const);
    const point = (face: number, corner: number): Vec => triangles[face]![corner]!;
    const groups = new Map<number, number[]>();
    for (let face = 0; face < roots.length; face++) {
        const root = roots[face]!;
        const group = groups.get(root);
        if (group)
            group.push(face);
        else
            groups.set(root, [face]);
    }
    function build(faces: number[]): Node {
        const min: [
            number,
            number,
            number
        ] = [Infinity, Infinity, Infinity];
        const max: [
            number,
            number,
            number
        ] = [-Infinity, -Infinity, -Infinity];
        for (const face of faces)
            for (let c = 0; c < 3; c++) {
                const p = point(face, c);
                for (let a = 0; a < 3; a++) {
                    min[a] = Math.min(min[a]!, p[a]!);
                    max[a] = Math.max(max[a]!, p[a]!);
                }
            }
        if (faces.length <= 12)
            return { min, max, faces };
        let axis = 0;
        for (let a = 1; a < 3; a++)
            if (max[a]! - min[a]! > max[axis]! - min[axis]!)
                axis = a;
        const center = (f: number) => point(f, 0)[axis]! + point(f, 1)[axis]! + point(f, 2)[axis]!;
        faces.sort((a, b) => center(a) - center(b));
        const mid = faces.length >> 1;
        return { min, max, faces: [], left: build(faces.slice(0, mid)), right: build(faces.slice(mid)) };
    }
    const trees = new Map<number, Node>();
    for (const [root, faces] of groups)
        trees.set(root, build(faces));
    return (root: number, origin: Vec, direction: Vec, reach: number): number => {
        let best = reach;
        let hit = false;
        const epsilon = Math.max(reach * 1e-7, 1e-9);
        function visit(node: Node): void {
            let near = 0, far = best;
            for (let a = 0; a < 3; a++) {
                const d = direction[a]!, o = origin[a]!;
                if (Math.abs(d) < 1e-12) {
                    if (o < node.min[a]! - epsilon || o > node.max[a]! + epsilon)
                        return;
                }
                else {
                    let t0 = (node.min[a]! - o) / d, t1 = (node.max[a]! - o) / d;
                    if (t0 > t1)
                        [t0, t1] = [t1, t0];
                    near = Math.max(near, t0);
                    far = Math.min(far, t1);
                    if (near > far + epsilon)
                        return;
                }
            }
            if (node.left)
                visit(node.left);
            if (node.right)
                visit(node.right);
            for (const face of node.faces) {
                const a = point(face, 0), b = point(face, 1), c = point(face, 2);
                const ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2];
                const fx = c[0] - a[0], fy = c[1] - a[1], fz = c[2] - a[2];
                const px = direction[1] * fz - direction[2] * fy;
                const py = direction[2] * fx - direction[0] * fz;
                const pz = direction[0] * fy - direction[1] * fx;
                const det = ex * px + ey * py + ez * pz;
                if (Math.abs(det) < 1e-12 * Math.hypot(ex, ey, ez) * Math.hypot(fx, fy, fz))
                    continue;
                if (det === 0)
                    continue;
                const tx = origin[0] - a[0], ty = origin[1] - a[1], tz = origin[2] - a[2];
                const u = (tx * px + ty * py + tz * pz) / det;
                if (u < -1e-7 || u > 1 + 1e-7)
                    continue;
                const qx = ty * ez - tz * ey, qy = tz * ex - tx * ez, qz = tx * ey - ty * ex;
                const v = (direction[0] * qx + direction[1] * qy + direction[2] * qz) / det;
                if (v < -1e-7 || u + v > 1 + 1e-7)
                    continue;
                const t = (fx * qx + fy * qy + fz * qz) / det;
                if (t > epsilon && t <= best) {
                    best = t;
                    hit = true;
                }
            }
        }
        const tree = trees.get(root);
        if (tree)
            visit(tree);
        return hit ? best : Infinity;
    };
}
