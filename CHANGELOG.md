# Changelog

All notable changes to this repository are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
