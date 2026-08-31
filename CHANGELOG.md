# Changelog

All notable changes to this repository are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/stefanodp91/obsidian-eclipse-graphic-engine/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/stefanodp91/obsidian-eclipse-graphic-engine/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/stefanodp91/obsidian-eclipse-graphic-engine/releases/tag/v0.1.0
