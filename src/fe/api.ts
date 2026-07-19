import { edenTreaty } from '@elysiajs/eden'
import type { App as ElysiaApp } from '@vrstevnice/be'

const API_BASE = import.meta.env.DEV
  ? 'http://localhost:3002'
  : (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3002')

export const treaty = edenTreaty<ElysiaApp>(API_BASE)
