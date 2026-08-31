// Pause the Babylon render loop while the tab is hidden; resume on focus.
// Saves battery + CPU on mobile and avoids burst-tick spikes on resume.

import type { AbstractEngine } from '@babylonjs/core';

export class RenderPauser {
    private readonly engine: AbstractEngine;
    private readonly render: () => void;
    private readonly onVisibility: () => void;
    private paused = false;

    constructor(engine: AbstractEngine, render: () => void) {
        this.engine = engine;
        this.render = render;
        this.onVisibility = (): void => {
            if (document.hidden && !this.paused) {
                this.engine.stopRenderLoop();
                this.paused = true;
            } else if (!document.hidden && this.paused) {
                this.engine.runRenderLoop(this.render);
                this.paused = false;
            }
        };
        document.addEventListener('visibilitychange', this.onVisibility);
    }

    dispose(): void {
        document.removeEventListener('visibilitychange', this.onVisibility);
    }
}
