# Changelog

All notable changes to the Endless Shark sample are documented here.

## Unreleased

### Changed

- Moved Babylon engine, scene, canvas, render-loop and disposal ownership to Reactylon while keeping
  procedural gameplay behind a lifecycle-safe bridge component.
- Replaced camera-locked luminous shafts with softly fading world-space light particles. Their
  moving emitter covers the endless route, while emitted particles retain independent world
  positions and visible parallax.
- Replaced repeated edge-triggered ascent with a balanced tap-and-hold control: tapping makes a
  fine correction, while holding applies gradual upward thrust capped at 3 m/s.
- Applied the same press-and-hold behavior to keyboard, pointer and touch input.

### Added

- A host-architecture regression test that prevents the sample from restoring direct Babylon
  engine or render-loop ownership.
- Regression tests for quick-tap sensitivity and useful sustained ascent.
