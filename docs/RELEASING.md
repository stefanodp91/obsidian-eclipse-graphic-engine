# Releasing

GitHub Releases are created automatically from semantic-version tags. The release workflow does
not publish to npm and does not deploy GitHub Pages.

## Prepare a release

1. Choose the next version using semantic versioning.
2. Update the `version` field in the root manifest, both package manifests, the Endless Shark
   manifest, and the sample-model manifest.
3. Run `npm install --package-lock-only` so `package-lock.json` records the same workspace versions.
4. Update user-facing changelogs when the release contains behavior changes.
5. Run `npm ci` followed by `npm run check` from a clean checkout.
6. Commit the version and changelog changes and merge them into `main`.

## Publish a release

Create and push an annotated tag from the release commit:

```bash
git switch main
git pull --ff-only
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0
```

The `Release` GitHub Actions workflow then:

- verifies that the tag matches every workspace version;
- installs from the lockfile and runs the complete project checks;
- packages the core and Capacitor npm tarballs without publishing them to npm;
- packages the built Endless Shark sample as a ZIP archive;
- generates SHA-256 checksums;
- creates a GitHub Release with automatically generated notes and attaches the artifacts.

If the workflow fails before publishing, fix the cause, delete the remote tag, recreate it on the
correct commit and push it again. Never move a tag after a successful public release; publish a new
patch version instead.
