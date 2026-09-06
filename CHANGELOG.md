# Changelog

All notable changes to this repository are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - Unreleased

Cumulative patch candidate; preparation does not publish a tag or release.

### Fixed

- Bound baked cel strokes using the opposite triangle surface of the same connected component
  and a volume/area size estimate. Bake-time BVHs replace vertex-neighbor searches, avoiding
  cross-component interference and full-width strokes on sparse tapered parts or missed rays.
  Ignore collapsed triangles in edge topology so closed sphere poles and tube caps can bake.
  Body bounds remain unchanged; the rendering path gains no extra pass.
- Clear stale per-mesh outline passes when switching to baked mode or disabling its fallback.
  Essential non-bakeable meshes and explicit no-fallback markers retain their contracts.
  Nine regressions cover sparse/tapered geometry, disconnected solids, closed caps, open surfaces
  and fallback transitions.

- Use outward-oriented normals for baked hull thickness searches, matching extrusion.
  Inward-authored normals previously searched outside the solid and left thin parts with
  the full requested stroke. Five regressions cover three geometry densities, thick solids,
  unchanged body geometry/bounds and pool reuse. This preserves the existing relative-width
  policy; it does not replace the sampled opposite-wall heuristic with a thickness guarantee.

- Pace capped rendering with cumulative deadlines instead of a half-period tolerance.
  Requested rates now remain accurate across 60/90/120 Hz callback streams, including
  non-divisor targets and jitter. Cap changes and resume render immediately; long stalls
  discard accumulated debt. Invalid targets remain uncapped. Display callbacks and rendering
  capacity bound the delivered rate; individual intervals remain display-quantized.
  Adds 40 deterministic pacing regressions.

- Establish render-loop gate ownership on the first active or inactive reconciliation. Previously,
  an already-active host loop was mistaken for the gated callback, leaving the first session
  uncapped until an inactive transition occurred. The gate now replaces existing callbacks,
  reconciles late host registration at the startup deadline, avoids duplicate callbacks, and
  cancels pending startup on cleanup. The existing startup delay is unchanged.

- Enforce the documented facade disposal contract for asset mutations, material release, pool
  registration/release/prewarm, and input event consumption. These operations now throw before
  reaching host services after `dispose()`, including when optional ports are absent. Reads,
  subscriptions, and previously returned cleanup functions retain their existing behavior.
  Hosts must release resources before facade disposal or clean up their owned services directly
  in `onDispose`; calling facade mutators from that callback is rejected. Regression coverage
  includes reentrant disposal and host cleanup failure.

## [0.2.0] - 2026-09-04

### Fixed

- Cel material plugin: the hatching mask now reads the quantized light band instead of the final
  pixel colour. Its window (`1 - smoothstep(0.30, 0.95, shade)`) was calibrated on band luminances,
  but the plugin was feeding it `dot(color.rgb, ...)` — the band already multiplied by albedo — so
  hatching tracked an object's **tint** rather than its **light**: a grey rock in full sunlight was
  hatched because it is grey, a white surface in shadow stayed clean because it is white, and a
  dark-toned scene was hatched edge to edge. The `ShaderMaterial` path was always correct; the two
  paths now agree, as their documentation already claimed. Regression test:
  `CelMaterialPlugin.hatch.test.ts`.

### Changed

- Cel hatching is now confined to the **darkest ramp band** and is zero everywhere else. The former
  window (`1 - smoothstep(0.30, 0.95, shade)`) gave the shadow band full hatching, the middle band
  about a third, and left only the brightest one clean — a calibration made against a lab rig lit by
  uniforms at intensity 1. Under a real lighting rig much of a scene falls in that middle range, so
  hatching appeared on surfaces the eye reads as lit. The boundary is now the band itself
  (`1/bands` on the pre-quantization ramp axis, with a short fade over its last 15%), which also
  makes it independent of the shadow tint — that tint is art direction and changes per level, while
  the band index does not. The ramp's band count reaches the shader as the new `celRampBands`
  uniform; `bands = 0` (a continuous ramp, where no darkest band exists) falls back to the
  lower third of the axis.

  The mask counts **self-emitted light as light** (`diffuseBase + emissiveColor`): a surface that
  glows is not in shadow. Without that term a self-lit object receives nothing, lands in the first
  band and takes full hatching — which is exactly what happened to a consumer's glowing collectibles
  before the term was added. Where the emissive is already folded into `diffuseBase`
  (`EMISSIVEASILLUMINATION`, `LINKEMISSIVEWITHDIFFUSE`) it is counted twice, which only pushes the
  mask toward "more lit", i.e. toward less hatching.

  Visible change for consumers who rely on hatching over midtones: it now reads as a shadow
  treatment rather than a surface texture. The mask needs no texture lookup of its own — it
  recomputes the ramp coordinate with a dot product — so this is not more expensive than 0.1.1.

- **Breaking (shader chunks).** `celHatch` in the exported `CEL_FRAGMENT_FUNCTIONS` chunk takes the
  ramp coordinate and the band count instead of a shade value, and `CEL_FRAGMENT_UNIFORMS` declares
  a new required `celRampBands`:

  ```glsl
  - float celHatch(vec2 fragCoord, float shade, float scale, float strength)
  + float celHatch(vec2 fragCoord, float rampU, float bands, float scale, float strength)
  ```

  `celRampCoord` and `celHatchMask` are new alongside them. Consumers on the `MaterialPluginBase`
  path need no changes. Anyone who binds these chunks into their own `ShaderMaterial` must pass the
  new argument and declare the uniform — an undeclared identifier does not compile. The cel
  subsystem remains an experimental prototype outside the engine's stable contract.

- Every source comment is now written in English and phrased for readers outside this project.
  Internal references to a particular downstream application, its levels and its assets were
  replaced with neutral descriptions, keeping the measurements intact. Two developer-facing strings
  changed with them: the `celLookRange` error message and the device-probe warning.

## [0.1.1] - 2026-08-31

### Added

- Added responsive Android and iOS reference hosts for the Endless Shark sample, including native
  build, target discovery and device deployment helpers.
- Added aspect-aware camera framing, portrait HUD behavior and native safe-area support to the
  playable sample.

### Changed

- Renamed the manual `CI` workflow to `Validate` and restricted it to explicit dispatches.
- Consolidated GitHub Release creation and GitHub Pages publication in the `Deploy` workflow.
- Restricted deployment to semantic-version tags so ordinary commits and pushes never change the
  published sample.
- Expanded native deployment, release and contribution documentation.

## [0.1.0] - 2026-08-31

### Added

- Initial independent release of the Babylon.js core, Capacitor adapters and Endless Shark sample.

[Unreleased]: https://github.com/stefanodp91/obsidian-eclipse-graphic-engine/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/stefanodp91/obsidian-eclipse-graphic-engine/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/stefanodp91/obsidian-eclipse-graphic-engine/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/stefanodp91/obsidian-eclipse-graphic-engine/releases/tag/v0.1.0
