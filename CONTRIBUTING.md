# Contributing

Thank you for contributing.

## Development setup

```bash
npm install
npm run check
```

Keep changes focused and include tests for public behavior. Public APIs must be reachable through a
declared package export; do not ask consumers to import internal source paths.

Changes to native capabilities must update the TypeScript, Android and iOS contracts together and
pass `npm run check:native`.

Changes to the native reference host or its launchers must keep both generated platform projects
synchronized. Run `shellcheck samples/endless-platformer-capacitor/android.sh
samples/endless-platformer-capacitor/ios.sh`, then use `./android.sh doctor` and `./ios.sh doctor`
from that sample directory. Platform changes should be compiled in Android Studio/Gradle and Xcode;
the root `npm run check` validates the shared web bundle but does not sign APK or IPA artifacts.

All Markdown documentation must be written in English. Keep architecture and lifecycle diagrams in
Mermaid so they render directly on GitHub. Do not add migration logs or references to private or
product-specific repositories. Run `npm run check:docs` after documentation changes.

Never commit credentials, personal email addresses, local home-directory paths, Firebase project
configuration, signing material, or consumer-specific secret names. Keep those values in the host
application or its protected CI environment and run `npm run check:sensitive` before committing.

## Pull requests

Describe the problem, the chosen behavior and the verification performed. Keep unrelated cleanup in
separate changes. By contributing, you agree that your contribution is licensed under the MIT
License included with this repository.

Pull requests do not run workflows in this repository. Contributors must run `npm run check`
locally or in their own fork and report the result in the pull request. The repository owner runs
CI after reviewing the contribution.
