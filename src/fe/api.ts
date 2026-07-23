import { edenTreaty } from '@elysiajs/eden';
import type { App as ElysiaApp } from '@vrstevnice/be';

let API_BASE = 'http://localhost:3002';
if (!import.meta.env.DEV && typeof window !== 'undefined') API_BASE = window.location.origin;

const treaty = edenTreaty<ElysiaApp>(API_BASE);
export default treaty;
