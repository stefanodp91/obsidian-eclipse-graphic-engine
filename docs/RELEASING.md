# Releasing

GitHub Releases and the GitHub Pages sample are deployed automatically from semantic-version tags.
The deployment workflow does not publish the packages to npm.

## Prepare a release

1. Choose the next version using semantic versioning.
2. Update the `version` field in the root manifest, both package manifests, the Endless Shark web
   and Capacitor manifests, and the sample-model manifest.
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

The `Deploy` GitHub Actions workflow then:

- verifies that the tag matches every workspace version;
- installs from the lockfile and runs the complete project checks;
- packages the core and Capacitor npm tarballs without publishing them to npm;
- packages the built Endless Shark sample as a ZIP archive;
- generates SHA-256 checksums;
- creates a GitHub Release with automatically generated notes and attaches the artifacts;
- deploys the same tagged build to GitHub Pages after the release succeeds.

The jobs run in this order:

```text
validate-and-build -> publish -> deploy-pages
```

The separate `Validate` workflow runs the same repository checks only when the repository owner
starts it manually from GitHub Actions. Commits, pull requests and pushes to `main` do not start
validation or deployment workflows.

The committed Android and iOS reference projects are validated through the Capacitor workspace,
but the release workflow does not produce signed APK or IPA files. Before a release that changes
native hosting, deploy the Android sample to an already connected `adb` target with `./android.sh`,
run `./ios.sh doctor`, and compile a representative iOS target.

## Verify GitHub Pages

The `Deploy` workflow publishes GitHub Pages after it creates a successful GitHub Release. The site
is built from the same tagged commit as the release assets, so ordinary commits and pushes to
`main` never change the published sample.

After pushing a semantic-version tag, wait for the validation, release and Pages deployment jobs
to succeed, then verify the
[playable sample](https://stefanodp91.github.io/obsidian-eclipse-graphic-engine/). A failed run must
be retried from GitHub Actions; pushing an ordinary commit does not retry or trigger the deployment.

If the workflow fails before publishing, fix the cause, delete the remote tag, recreate it on the
correct commit and push it again. Never move a tag after a successful public release; publish a new
patch version instead.
