// Opaque handles. Babylon objects (Mesh, Material) never leak through the Facade
// except via a documented, typed escape hatch (`handle.unwrap()`). Branded types
// keep the boundary explicit WITHOUT importing @babylonjs/core into the domain.

declare const brand: unique symbol;
type Branded<T, B extends string> = T & { readonly [brand]: B };

/** `unwrap()` returns the underlying Babylon object (typed in the babylon
 *  adapter); `unknown` here keeps the domain dependency-free. */
export type MeshHandle = Branded<{ unwrap(): unknown }, 'MeshHandle'>;
export type MaterialHandle = Branded<{ unwrap(): unknown }, 'MaterialHandle'>;
export type PoolHandle = Branded<{ readonly id: string }, 'PoolHandle'>;

/** Asset cache lifetime tier: global (app session) / world (per world, dropped on
 *  swap) / level (thin, reuses global+world). Device-class concept, no game content. */
export type AssetTier = 'global' | 'world' | 'level';
