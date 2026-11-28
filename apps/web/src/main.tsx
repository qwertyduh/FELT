import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { startAuth } from './lib/auth';
import { isPublicPath } from './lib/recap';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

// Single-flight; runs once outside React so StrictMode can't double it. A shared recap is read
// signed out: opening one must not create an anonymous user.
if (!isPublicPath(window.location.pathname)) void startAuth();

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
