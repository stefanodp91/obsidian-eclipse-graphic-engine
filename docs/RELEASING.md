# Releasing

GitHub Releases and the GitHub Pages sample are deployed automatically from semantic-version tags.
The deployment workflow does not publish the packages to npm.

## What earns a release

**A release must carry a runtime change.** Documentation, comments, release guides and repository
policy never become a version of their own: they wait on `main` and ship with the next patch that
changes behavior. A version that a consumer cannot act on still costs everyone who sees it a
decision — read the notes, bump the dependency, re-verify the build — and returns nothing.

`main` sitting ahead of the last tag is therefore the normal state, not a gap to close.

## Prepare a release

1. Choose the next version using semantic versioning.
2. Update the `version` field in the root manifest, both package manifests, the Endless Shark web
   and Capacitor manifests, and the sample-model manifest.
3. Run `npm install --package-lock-only` on **Node 22 / npm 10**, the pair the release runner uses,
   so `package-lock.json` records the same workspace versions. Then confirm it still records every
   platform binary with `grep -c '"node_modules/@rollup/rollup-' package-lock.json`, which must
   report every published variant rather than one: a newer npm regenerating the lockfile against an
   already platform-filtered `node_modules` keeps only the host's own binary, which installs locally
   and fails on the Linux runner with `Cannot find module @rollup/rollup-linux-x64-gnu`. Recovering
   from that state needs a full `npm install` from an absent `node_modules`, not another
   `--package-lock-only`.
4. Update user-facing changelogs when the release contains behavior changes.
5. Run `npm ci` followed by `npm run check` from a clean checkout.
6. Package local candidates with `npm pack --workspace ... --pack-destination <candidate-dir>`
   and archive the built sample. Record SHA-256 checksums separately from future official assets.
7. Smoke-test the actual tarballs in a clean external consumer (exports, declarations and packaging).
8. Commit the version and changelog changes and merge them into `main`.

Preparation is local. Do not tag, push a release tag, start remote validation, or publish assets
without an explicit owner request for that action. If `npm run check` fails, preserve the failing
gate and report the blocker; a passing subset is not release approval. The sensitive-data gate scans
tracked content, including email literals in the checker itself. Git author metadata is outside
that content scan; never encode personal identities or address allowlists in source code.

The current [0.2.1 release notes](releases/0.2.1.md) record compatibility and validation status.

## Publish a release

Create and push an annotated tag from the release commit:

```bash
git switch main
git pull --ff-only
git tag -a v0.2.1 -m "Release v0.2.1"
git push origin v0.2.1
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

That rule was overridden once, on 2026-09-08 and by explicit owner decision, to withdraw a
documentation-only 0.2.2 and absorb it into 0.2.1. The price is recorded here because it is the
argument against doing it again: the 0.2.1 artifacts were rebuilt, so their checksums no longer
match the ones published on 2026-09-06, and every consumer that pinned the earlier archive by
integrity fails to install until it refreshes its lockfile. The version number stayed still while
the bytes moved underneath it, which is exactly what a version number exists to prevent.
