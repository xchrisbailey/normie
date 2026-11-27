import { createRoot } from 'react-dom/client';
import { expected } from '../core/errors';
import { App } from './App';
import { waitForCore } from './core-client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles.css';
import { applyAppearance } from './appearance';
import { applyTheme, launchTheme } from './theme';

// The theme and the rest of the appearance first, so the first frame is already right.
applyTheme(launchTheme());
applyAppearance(window.normie.appearance.current());
// On a Mac the header row sits under the window's traffic lights, so it needs room above it.
document.documentElement.dataset.platform = window.normie.platform;

// A file dropped anywhere but the composer is ignored, never opened in the window.
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (e) => e.preventDefault());
}

// After a few quiet seconds, give back memory nothing on screen needs any more (#75). Once per quiet spell.
let quietTimer: ReturnType<typeof setTimeout> | undefined;
const quiet = () => {
  clearTimeout(quietTimer);
  quietTimer = setTimeout(() => window.normie.trimMemory(), 5000);
};
for (const type of ['keydown', 'pointerdown', 'wheel'] as const) {
  window.addEventListener(type, quiet, { passive: true, capture: true });
}

// Render at once, from the snapshot; the core's port arrives a moment later.
createRoot(expected(document.getElementById('root'), 'the #root element')).render(<App corePromise={waitForCore()} />);
