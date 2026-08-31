# Cel rendering

The cel subsystem is experimental public API. It combines material shading, cached ramp and hatch
textures, analytic grading, optional deformation, and outline strategies. Consumers should pin an
engine version and validate visuals before adopting it in a stable product.

```mermaid
flowchart LR
    Mesh[Mesh geometry] --> Plugin[Cel material plugin]
    Ramp[Cel ramp] --> Plugin
    Hatch[Hatch texture] --> Plugin
    Motion[Wind, surge, flap, bob] --> Plugin
    Plugin --> Shade[Shaded scene]
    Shade --> Outline[Post-process or hull outline]
    Outline --> Grade[Analytic cel grade]
    Grade --> Frame[Final frame]
```

## Main surfaces

- `createCelMaterial()` creates a dedicated cel material and handle.
- `registerCelPlugin()` adds cel behavior to compatible existing materials.
- `getCelRamp()` and `getCelHatch()` cache generated lookup textures.
- `attachCelOutline()` installs the selective outline post-process.
- hull helpers provide a geometry-based alternative and preserve the original body bounds.
- `applyCelLook()` and `applyCelGrade()` update coherent groups of look controls.

The default outline choice is the post-process path. Hull mode remains useful for comparison and
special cases but can expose gaps on hard-edged geometry with split normals.

## Ownership

The engine owns shader mechanics and safe defaults. The consumer owns palette, artistic direction,
mesh eligibility, texture budget, and acceptance tests. Dispose cached ramps, hatches, post-processes,
and handles when their scene is destroyed.
