import { createRoot } from 'react-dom/client';
import { App } from './App';
import { waitForCore } from './core-client';
import './styles.css';

// A file dropped anywhere but the composer is ignored, never opened in the window.
for (const type of ['dragover', 'drop'] as const) window.addEventListener(type, (e) => e.preventDefault());

// Render at once, from the snapshot; the core's port arrives a moment later.
createRoot(document.getElementById('root')!).render(<App corePromise={waitForCore()} />);
