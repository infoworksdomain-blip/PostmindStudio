import { createRoot } from 'react-dom/client';
import { installMockFetch } from './api/registry';
import './api/handlers';
import { DemoApp } from './app';
import { installTourParams } from './tour-params';

// Demo build entry: the sample API must be installed before any screen fetches, and a tour link's
// ?demoPlan= / ?lang= applied before the first screen renders.
installMockFetch();
installTourParams();

const root = document.getElementById('studio-demo-root');
if (root) createRoot(root).render(<DemoApp />);
