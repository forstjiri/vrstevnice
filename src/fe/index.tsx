import { render } from 'solid-js/web'
import App from './App'
import './app.css'

const SUPPRESSED = [
  'ArrayBuffer at index 0 is already detached',
  'attempting to access detached ArrayBuffer',
  'source image could not be decoded',
  'An attempt was made to use an object that is not, or is no longer, usable',
]

const origError = console.error
console.error = (...args: unknown[]) => {
  const msg = args.map(a => typeof a === 'string' ? a : a instanceof Error ? a.message : '').join(' ')
  if (SUPPRESSED.some(p => msg.includes(p))) return
  origError.apply(console, args)
}

window.addEventListener('error', (e: ErrorEvent) => {
  if (e.message && SUPPRESSED.some(p => e.message.includes(p))) e.preventDefault()
})

window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  const msg = e.reason instanceof Error ? e.reason.message : String(e.reason)
  if (SUPPRESSED.some(p => msg.includes(p))) e.preventDefault()
})

render(() => <App />, document.getElementById('app')!)
