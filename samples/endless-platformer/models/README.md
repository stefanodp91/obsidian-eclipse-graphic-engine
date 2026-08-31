# Endless Shark models

Importable Babylon.js fauna models used by the Endless Shark example. This directory is a separate
TypeScript package and contains no gameplay, input, camera or scoring code.

## Structure

```text
src/
  _lib/                    shared geometry and PBR material primitives
  fauna/
    great-white/           tier dispatch, complete model and typed animation handle
    sardine/               tier dispatch, model and tail handle
    reef-squid/            common-squid model, tier dispatch and arm/tentacle handles
  environment/
    mediterranean-shelf/   limestone outcrops and Posidonia oceanica patches
  lod.ts                   ModelTier enum
  index.ts                 public package barrel
```

Each model folder has a public `index.ts`, explicit option/handle types, low/medium/high entries and
a shared geometry assembly. Consumers import only from `@obsidian-eclipse/endless-shark-models`.

## API

```ts
import {
  ModelTier,
  buildGreatWhite,
  buildSardine,
  buildReefSquid,
  applyGreatWhitePose,
  applySardinePose,
  applyReefSquidPose,
  buildLimestoneGate,
  buildPosidoniaPatch,
  applyPosidoniaPose,
} from '@obsidian-eclipse/endless-shark-models';

const shark = buildGreatWhite(ModelTier.High, { scene, scale: 0.6 });
const sardine = buildSardine(ModelTier.Medium, { scene, phase: 1.2 });
const squid = buildReefSquid(ModelTier.Medium, { scene, phase: 2.4 });
const meadow = buildPosidoniaPatch({ scene, seed: 42, width: 8 });

applyGreatWhitePose(shark, elapsedSeconds, biteProgress01);
applySardinePose(sardine, elapsedSeconds, panic01);
applyReefSquidPose(squid, elapsedSeconds, panic01);
applyPosidoniaPose(meadow, elapsedSeconds);
```

Builders return typed handles instead of hiding animation pivots. The caller owns placement and
lifecycle and can call each handle's `dispose()` method.

## Model contract

- Geometry is original and procedural; there are no downloaded meshes or third-party textures.
- Biological surfaces are dielectric (`metallic = 0`): denticle relief, wet-skin roughness,
  guanine-like fish reflectance and chromatophore colour are represented independently.
- The great white uses a robust fusiform body, conical snout, five gill slits, paired pectorals,
  large first dorsal, small second dorsal, caudal keel and lunate tail.
- Countershading is encoded in vertex colors and rendered through a rough PBR skin with a generated
  dermal-denticle bump pattern.
- Feeding has a separately articulated mandible and visible tooth rows.
- Sardines use a compressed silver fusiform body, green-grey dorsum and forked tail.
- Sardines add opercular striae, soft dorsal/anal fins and a dielectric guanine-reflector band.
- The common squid uses a long cylindrical mantle, extended rhomboidal fins, chromatophore marks,
  eight arms and two longer feeding tentacles at high tier.
- The same typed pose functions drive normal swimming and predator-response animation.

Research sources and the implementation traits derived from them are documented in
[`REFERENCES.md`](REFERENCES.md).

## Typecheck

From this directory, after installing repository dependencies:

```bash
npm run typecheck
```
