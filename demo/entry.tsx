import { createRoot } from 'react-dom/client';
import { installMockFetch } from './api/registry';
import './api/handlers';
import { DemoApp } from './app';

// Demo build entry: the sample API must be installed before any screen fetches.
installMockFetch();

const root = document.getElementById('studio-demo-root');
if (root) createRoot(root).render(<DemoApp />);
