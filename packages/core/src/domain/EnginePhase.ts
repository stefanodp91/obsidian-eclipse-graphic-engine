// Engine render/physics lifecycle state (State pattern -> render gating).
// The host maps its own phases onto these three; the engine knows only these.
// See ../../wiki/engine-lifecycle.md.

export enum EnginePhase {
  /** Render loop on, physics on (gameplay). */
  Active = 'active',
  /** Render loop on, physics off (win / fail / cutscene). */
  Reduced = 'reduced',
  /** Render loop off (menu / paused / boot). */
  Halted = 'halted',
}
