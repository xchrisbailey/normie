import { createRoot } from 'react-dom/client';
import { App } from './App';
import { waitForCore } from './core-client';
import './styles.css';

const root = createRoot(document.getElementById('root')!);
void waitForCore().then((core) => root.render(<App core={core} />));
