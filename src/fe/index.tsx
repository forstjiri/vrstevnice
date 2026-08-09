import { render } from 'solid-js/web';
import App from './App';
import './app.css';
import './components.css';

const SUPPRESSED = [
  'ArrayBuffer at index 0 is already detached',
  'attempting to access detached ArrayBuffer',
  'source image could not be decoded',
  'An attempt was made to use an object that is not, or is no longer, usable',
];

const origError = globalThis.console.error;
globalThis.console.error = (...args: Parameters<Console['error']>) => {
  const msg = args.map((a) => {
    if (typeof a === 'string') return a;
    return a instanceof Error ? a.message : '';
  }).join(' ');
  if (SUPPRESSED.some((p) => msg.includes(p))) return;
  origError.apply(globalThis.console, args);
};

window.addEventListener('error', (e: ErrorEvent) => {
  if (e.message && SUPPRESSED.some((p) => e.message.includes(p))) e.preventDefault();
});

window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  const msg = e.reason instanceof Error ? e.reason.message : String(e.reason);
  if (SUPPRESSED.some((p) => msg.includes(p))) e.preventDefault();
});

const root = document.getElementById('app');
if (root) render(() => <App />, root);
