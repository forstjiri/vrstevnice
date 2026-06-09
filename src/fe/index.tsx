import { render } from 'solid-js/web'
import App from './App'
import './app.css'

const SUPPRESSED_PATTERNS = [
  'ArrayBuffer at index 0 is already detached',
  'source image could not be decoded',
]

const origError = console.error
console.error = (...args) => {
  const msg = args.map(a => typeof a === 'string' ? a : a instanceof Error ? a.message : '').join(' ')
  if (SUPPRESSED_PATTERNS.some(p => msg.includes(p))) return
  origError.apply(console, args)
}

window.addEventListener('error', (e) => {
  if (e.message && SUPPRESSED_PATTERNS.some(p => e.message.includes(p))) {
    e.preventDefault()
  }
})

window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason
  const msg = reason instanceof Error ? reason.message : String(reason)
  if (SUPPRESSED_PATTERNS.some(p => msg.includes(p))) {
    e.preventDefault()
  }
})

render(() => <App />, document.getElementById('app')!)
