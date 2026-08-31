# Biological and motion references

The models are original procedural geometry. Sources below were used only to extract anatomical and
behavioral invariants.

## Great white shark — *Carcharodon carcharias*

- [NOAA Fisheries — White Shark](https://www.fisheries.noaa.gov/species/white-shark): robust
  torpedo-shaped body, conical snout, prominent caudal keel, crescent-shaped tail, large pointed
  first dorsal, broad triangular teeth and opportunistic fish diet.
- [NOAA technical species description](https://repository.library.noaa.gov/view/noaa/42001/noaa_42001_DS1.pdf):
  greatest body depth near the first dorsal, five large gill openings, long pointed pectorals,
  flattened caudal peduncle and nearly symmetric lunate caudal fin.
- [FAO Mediterranean shark identification guide](https://www.fao.org/4/y5945e/y5945e03.pdf):
  conical snout, small second dorsal/anal fins, strong keel, serrated triangular teeth and confirmed
  distribution throughout the Mediterranean outside the Black Sea.
- [NOAA National Marine Sanctuaries — shark anatomy](https://sanctuaries.noaa.gov/magazine/4/sharks-in-sanctuaries/):
  dark dorsal/white ventral countershading, dermal denticles and tail-driven acceleration.
- [Smithsonian Ocean — Great White Shark](https://ocean.si.edu/ocean-life/sharks-rays/great-white-shark):
  torpedo silhouette, sensory pores, lateral line and fish/squid prey.
- [Smithsonian Ocean — shark denticles](https://ocean.si.edu/ocean-life/sharks-rays/biomimicry-shark-denticles):
  rear-facing V-shaped dermal denticles that reduce turbulence.
- [Donley et al., Nature — lamnid shark and tuna mechanical convergence](https://www.nature.com/articles/nature02435.pdf):
  thunniform locomotion concentrates lateral undulation toward the caudal region rather than
  bending the entire body uniformly.
- [White-shark burst behavior study](https://doi.org/10.1071/WR24112): burst events increase
  tail-beat amplitude and frequency; this informs the strike animation without inventing whole-body
  spinning.
- [Mechanics of biting in great white sharks](https://pubmed.ncbi.nlm.nih.gov/21129747/) and
  [white-shark tooth position](https://pubmed.ncbi.nlm.nih.gov/29865343/): articulated jaw opening,
  broad triangular tooth rows and tooth rotation during feeding.

## Sardines and collective escape

- [FishBase — European sardine](https://www.fishbase.se/summary/Sardina-pilchardus): fusiform,
  sub-cylindrical fusiform body with compressed cross-section, rounded belly, common size around
  20 cm and distribution in the Mediterranean and Adriatic.
- [Funt et al. — fish-scale iridophores](https://doi.org/10.1002/cplu.201700151): guanine
  crystal platelets form multilayer biological reflectors and lie predominantly parallel to the
  scale surface. This supports a bright dielectric flank, not a metallic material.
- [Speed-mediated properties of schooling](https://pmc.ncbi.nlm.nih.gov/articles/PMC6408369/):
  faster groups become more aligned, linearly arranged and elongated.
- [Inferring interaction rules of shoaling fish](https://pmc.ncbi.nlm.nih.gov/articles/PMC3219133/):
  attraction, collision avoidance and response to nearby individuals rather than a global leader.
- [Collective anti-predator escape manoeuvres](https://pmc.ncbi.nlm.nih.gov/articles/PMC11603345/):
  sardine schools form a fountain-like split around an attacking predator; the example maps this
  to vertical separation and forward acceleration near the shark.
- [Review of collective-motion models](https://pmc.ncbi.nlm.nih.gov/articles/PMC3499128/):
  repulsion, attraction, local alignment and stochastic variation are the minimal useful school
  behaviors.

## Implementation decisions

The side view preserves the diagnostic silhouette. Tail motion is applied around a caudal pivot,
not as rigid-body rotation. A feeding event temporarily increases tail frequency and opens the
mandible. Sardines retain phase offsets while schooling and increase tail frequency while escaping.
The squid contracts its mantle and articulates arm pivots independently.

## Mediterranean habitat and underwater optics

- [IUCN — Mediterranean seagrass meadows](https://iucn.org/content/seagrass-meadows-hot-water-iucn):
  *Posidonia oceanica* is endemic to the Mediterranean and forms one of its three principal
  seagrass habitats.
- [IUCN — Posidonia ecology](https://iucn.org/news/202607/second-season-cherish-nature-spain-launches-to-protect-mediterranean-seagrass-meadows):
  meadows reach roughly 40–45 m and serve as feeding, shelter and breeding habitat.
- [FAO — *Loligo* squid](https://www.fao.org/4/x5948e/x5948e01.htm): a blunt posterior mantle and
  paired fins forming a diamond-like outline; these traits replace the generic “reef squid” look.
- [FAO — Cephalopods of the World](https://www.fao.org/4/i1920e/i1920e02.pdf): *Loligo* mantle
  long and cylindrical, fins rhomboidal and extended across roughly three quarters of the mantle,
  with dark purplish chromatophore markings.
- [NOAA NESDIS optical model](https://www.nesdis.noaa.gov/s3/2025-12/ATBD_Enterprise_Aerosol_Optical_Depth_v3.2_2020-09-22.pdf):
  seawater refractive index 1.339 at 0.555 μm, used by the air-water PBR interface.
- [NEMO Collaboration — Southern Ionian Sea optical properties](https://arxiv.org/abs/astro-ph/0603701):
  blue-light absorption near 0.015 m⁻¹ in clear deep Mediterranean water. The sample maps this
  qualitatively to blue-green distance fog and declining contrast; it does not claim a calibrated
  radiative-transfer simulation.

All PBR roughness values are declared rendering approximations because the cited biological and
optical sources do not publish Babylon-specific parameters. They are never presented as measured
material constants. Metallic is kept at zero for animal tissue and guanine-bearing scales.
