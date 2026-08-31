# Obsidian Eclipse Graphic Engine

Open-source runtime packages for Babylon.js and Capacitor applications.

## Playable sample

[Play Endless Shark](https://stefanodp91.github.io/obsidian-eclipse-graphic-engine/) directly in your browser.

Endless Shark is a React 19 application hosted by
[Reactylon 3.5.8](https://www.reactylon.com/docs). Reactylon owns the Babylon.js engine, scene,
canvas, render loop, and their disposal. The procedural game adopts that scene through a small
bridge exported by `obsidian-eclipse-graphic-engine/reactylon`. Reactylon is an optional peer of the
core package, so the integration is supported without imposing React on Babylon-only consumers.

| Ready to enter the current | Hunting across the Mediterranean shelf |
| --- | --- |
| ![Endless Shark start screen with the shark, HUD, and controls](docs/assets/endless-shark-ready.jpg) | ![Endless Shark gameplay with the shark hunting a school of fish](docs/assets/endless-shark-gameplay.jpg) |

Run the playable web sample locally:

```bash
npm install
npm run dev
```

The same sample includes a Capacitor host with deployment launchers for physical devices and
running emulators/simulators:

```bash
npm run android
npm run ios
npm run build:apk
npm run build:ipa
```

See the [Capacitor sample guide](samples/endless-platformer-capacitor/README.md) for Android, Xcode
discovers a target and deploys the application. The Android launcher follows a scripted flow:
it selects the Homebrew JDK 21, builds and synchronizes the web application, assembles the debug
APK, installs it and launches it on an already connected `adb` target. Both the web and native
variants adapt their camera and HUD to portrait and landscape screens.

## Architecture

```mermaid
flowchart LR
    React[React application] --> Reactylon[Reactylon host]
    Reactylon --> Scene[Babylon.js Engine and Scene]
    Scene --> Bridge[Scene adoption bridge]
    Bridge --> Core[Graphic engine core]
    Babylon[Imperative Babylon.js application] --> Adapter[Babylon.js adapter]
    Adapter --> Core
    Native[Android or iOS application] --> Capacitor[Capacitor adapter]
    Capacitor --> Core
```

### Where Reactylon is used

| Location | Role |
| --- | --- |
| [`packages/core/src/adapters/reactylon/index.ts`](packages/core/src/adapters/reactylon/index.ts) | Implements the engine's public `ReactylonSceneBridge` integration. |
| [`samples/endless-platformer/src/main.tsx`](samples/endless-platformer/src/main.tsx) | Uses Reactylon's `Engine` and `Scene` with the engine-provided bridge. |
| [`samples/endless-platformer/src/game.ts`](samples/endless-platformer/src/game.ts) | Receives the Reactylon-owned Babylon scene and mounts the procedural game into it. |
| [`docs/adr/0002-reactylon-as-optional-scene-owner.md`](docs/adr/0002-reactylon-as-optional-scene-owner.md) | Records the ownership boundary and optional peer-dependency decision. |

```text
packages/core/                 Babylon.js runtime and adapters
packages/capacitor/            optional Capacitor services and native plugins
samples/endless-platformer/    playable Reactylon-hosted reference game
samples/endless-platformer-capacitor/ native Android and iOS host for the sample
docs/adr/                      architecture decisions
```

## Get started

```bash
npm install
npm run check
```

Package documentation:

- [`obsidian-eclipse-graphic-engine`](packages/core/README.md)
- [`obsidian-eclipse-capacitor-plugins`](packages/capacitor/README.md)
- [Core architecture and guides](packages/core/wiki/index.md)
- [Capacitor architecture and guides](packages/capacitor/wiki/index.md)
- [Playable Endless Platformer sample](samples/endless-platformer/README.md)
- [Native Capacitor sample and device launchers](samples/endless-platformer-capacitor/README.md)

## Credits

[Reactylon](https://www.reactylon.com/docs) was created by Simone De Vittorio and is used under the
MIT License. See [Credits and third-party software](THIRD_PARTY_NOTICES.md) for Reactylon,
Babylon.js, Havok integration, React, their upstream projects, and license information.

## Releases

GitHub Releases are generated automatically from semantic-version tags. Each release contains the
core and Capacitor package tarballs, the built Endless Shark sample, and SHA-256 checksums. See
[`docs/RELEASING.md`](docs/RELEASING.md) for the release procedure.

## License

MIT © Obsidian Eclipse contributors.
