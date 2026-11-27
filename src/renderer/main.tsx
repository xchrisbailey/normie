import { createRoot } from 'react-dom/client';
import { App } from './App';
import { waitForCore } from './core-client';
import './styles.css';

// A file dropped anywhere but the composer is ignored, never opened in the window.
for (const type of ['dragover', 'drop'] as const) window.addEventListener(type, (e) => e.preventDefault());

// After a few quiet seconds, give back memory nothing on screen needs any more (#75). Once per quiet spell.
let quietTimer: ReturnType<typeof setTimeout> | undefined;
const quiet = () => {
  clearTimeout(quietTimer);
  quietTimer = setTimeout(() => window.normie.trimMemory(), 5000);
};
for (const type of ['keydown', 'pointerdown', 'wheel'] as const) window.addEventListener(type, quiet, { passive: true, capture: true });

// Render at once, from the snapshot; the core's port arrives a moment later.
createRoot(document.getElementById('root')!).render(<App corePromise={waitForCore()} />);
