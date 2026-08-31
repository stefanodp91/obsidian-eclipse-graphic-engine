import { createRoot } from 'react-dom/client';
import { Scene } from 'reactylon';
import { Engine } from 'reactylon/web';
import { ReactylonSceneBridge } from 'obsidian-eclipse-graphic-engine/reactylon';
import { mountEndlessPlatformer } from './game';
import './style.css';

function App() {
  return (
    <Engine
      forceWebGL
      canvasId="game"
      engineOptions={{
        antialias: true,
        preserveDrawingBuffer: false,
        disableWebGL2Support: true,
      }}
    >
      <Scene>
        <ReactylonSceneBridge mount={mountEndlessPlatformer} />
      </Scene>
    </Engine>
  );
}

const rootElement = document.querySelector<HTMLElement>('#scene-root');
if (!rootElement) throw new Error('Missing #scene-root');

createRoot(rootElement).render(<App />);
