# Credits and third-party software

Obsidian Eclipse Graphic Engine is original software distributed under the repository's
[MIT License](LICENSE). It builds on the open-source projects below. Each project remains subject
to its own copyright and license terms.

## Reactylon

[Reactylon](https://www.reactylon.com/docs) is a custom React renderer for Babylon.js created by
Simone De Vittorio. This repository uses Reactylon 3.5.8 and
[`babel-plugin-reactylon`](https://www.npmjs.com/package/babel-plugin-reactylon) in the Endless Shark
sample. Reactylon is licensed under the MIT License.

- [Source repository](https://github.com/simonedevit/reactylon)
- [Documentation](https://www.reactylon.com/docs)
- [Engine and Scene documentation](https://www.reactylon.com/docs/engine-scene)
- [Hooks documentation](https://www.reactylon.com/docs/hooks)

## Babylon.js

[Babylon.js](https://www.babylonjs.com/) provides the WebGL rendering runtime and is licensed under
the Apache License 2.0. The repository uses the modular `@babylonjs/core` and `@babylonjs/gui`
packages.

- [Source repository](https://github.com/BabylonJS/Babylon.js)
- [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)

## Havok integration

The engine supports the optional `@babylonjs/havok` package for physics. The package is distributed
by the Babylon.js project under the MIT License. Endless Shark does not load Havok.

- [Babylon.js physics documentation](https://doc.babylonjs.com/features/featuresDeepDive/physics/)
- [Package](https://www.npmjs.com/package/@babylonjs/havok)

## React

[React](https://react.dev/) and React DOM provide the application host for Endless Shark and are
licensed under the MIT License.

- [Source repository](https://github.com/facebook/react)

## Capacitor

[Capacitor](https://capacitorjs.com/) provides the native Android/iOS bridge, CLI, platform hosts,
Device and Preferences plugins used by the optional adapter and native sample. The repository also
uses the Capacitor Community Keep Awake plugin. These dependencies are licensed under the MIT
License.

- [Capacitor source repository](https://github.com/ionic-team/capacitor)
- [Capacitor plugins source repository](https://github.com/ionic-team/capacitor-plugins)
- [Keep Awake source repository](https://github.com/capacitor-community/keep-awake)

## Assets and dependency records

Endless Shark uses original procedural geometry and textures; it contains no downloaded game art,
audio, meshes, or third-party textures. Biological and biomechanical research sources are listed
separately in [`samples/endless-platformer/models/REFERENCES.md`](samples/endless-platformer/models/REFERENCES.md).

The exact resolved versions and declared licenses for the complete dependency graph are recorded in
[`package-lock.json`](package-lock.json). Bundled dependencies retain their original notices and
license terms.
