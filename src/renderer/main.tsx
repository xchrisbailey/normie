import { createRoot } from 'react-dom/client';
import { App } from './App';
import { waitForCore } from './core-client';
import './styles.css';

// Render at once, from the snapshot; the core's port arrives a moment later.
createRoot(document.getElementById('root')!).render(<App corePromise={waitForCore()} />);
