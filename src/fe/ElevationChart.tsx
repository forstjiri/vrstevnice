import { onMount, onCleanup, createEffect, Show } from 'solid-js'
import { useApp } from './App'

const PADDING = { top: 8, right: 12, bottom: 22, left: 42 }
const TOOLTIP_OFFSET = 12

export default function ElevationChart() {
  const { route, setHoveredPoint } = useApp()
  let container!: HTMLDivElement
  let canvas!: HTMLCanvasElement
  let ctx: CanvasRenderingContext2D | null = null
  let dpr = 1
  let displayWidth = 0
  let displayHeight = 0
  let ro: ResizeObserver | null = null
  let rafId = 0

  function setupCanvas() {
    if (!container || !canvas) return
    dpr = window.devicePixelRatio || 1
    const rect = container.getBoundingClientRect()
    displayWidth = rect.width
    displayHeight = rect.height
    canvas.width = Math.round(displayWidth * dpr)
    canvas.height = Math.round(displayHeight * dpr)
    ctx = canvas.getContext('2d')
    if (ctx) ctx.scale(dpr, dpr)
  }

  function draw(hoverDist?: number, hoverElev?: number) {
    if (!ctx) return
    const r = route()
    const profile = r?.elevationProfile
    if (!profile || profile.length === 0) return

    const w = displayWidth
    const h = displayHeight
    const plotX = PADDING.left
    const plotY = PADDING.top
    const plotW = w - PADDING.left - PADDING.right
    const plotH = h - PADDING.top - PADDING.bottom

    ctx!.clearRect(0, 0, w, h)

    // Compute data bounds
    const totalDist = profile[profile.length - 1].distance
    let minElev = Infinity
    let maxElev = -Infinity
    for (const p of profile) {
      if (p.elevation < minElev) minElev = p.elevation
      if (p.elevation > maxElev) maxElev = p.elevation
    }
    // Add a small padding to elevation range for breathing room
    const elevRange = maxElev - minElev || 1
    minElev -= elevRange * 0.05
    maxElev += elevRange * 0.05
    const elevSpan = maxElev - minElev

    function toX(dist: number) {
      return plotX + (dist / totalDist) * plotW
    }
    function toY(elev: number) {
      return plotY + plotH - ((elev - minElev) / elevSpan) * plotH
    }

    // Draw filled area with gradient
    const grad = ctx!.createLinearGradient(0, plotY, 0, plotY + plotH)
    grad.addColorStop(0, 'rgba(37, 99, 235, 0.35)')
    grad.addColorStop(1, 'rgba(37, 99, 235, 0.03)')

    ctx!.beginPath()
    ctx!.moveTo(toX(profile[0].distance), toY(profile[0].elevation))
    for (let i = 1; i < profile.length; i++) {
      ctx!.lineTo(toX(profile[i].distance), toY(profile[i].elevation))
    }
    ctx!.lineTo(toX(profile[profile.length - 1].distance), plotY + plotH)
    ctx!.lineTo(toX(profile[0].distance), plotY + plotH)
    ctx!.closePath()
    ctx!.fillStyle = grad
    ctx!.fill()

    // Draw elevation line
    ctx!.beginPath()
    ctx!.moveTo(toX(profile[0].distance), toY(profile[0].elevation))
    for (let i = 1; i < profile.length; i++) {
      ctx!.lineTo(toX(profile[i].distance), toY(profile[i].elevation))
    }
    ctx!.strokeStyle = '#2563eb'
    ctx!.lineWidth = 1.5
    ctx!.lineJoin = 'round'
    ctx!.stroke()

    // Y-axis labels
    ctx!.font = '10px ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace'
    ctx!.fillStyle = '#9ca3af'
    ctx!.textAlign = 'right'
    ctx!.textBaseline = 'middle'
    const ySteps = 4
    for (let i = 0; i <= ySteps; i++) {
      const elev = minElev + (elevSpan * i) / ySteps
      const y = toY(elev)
      ctx!.fillText(Math.round(elev) + ' m', plotX - 6, y)
      // Light grid line
      ctx!.beginPath()
      ctx!.moveTo(plotX, y)
      ctx!.lineTo(plotX + plotW, y)
      ctx!.strokeStyle = 'rgba(0,0,0,0.05)'
      ctx!.lineWidth = 1
      ctx!.stroke()
    }

    // X-axis labels
    ctx!.textAlign = 'center'
    ctx!.textBaseline = 'top'
    const xSteps = Math.min(5, Math.max(2, Math.floor(plotW / 80)))
    for (let i = 0; i <= xSteps; i++) {
      const dist = (totalDist * i) / xSteps
      const x = toX(dist)
      const km = dist / 1000
      ctx!.fillStyle = '#9ca3af'
      ctx!.fillText(km.toFixed(1) + ' km', x, plotY + plotH + 4)
    }

    // Crosshair + tooltip on hover
    if (hoverDist !== undefined && hoverElev !== undefined) {
      const hx = toX(hoverDist)
      const hy = toY(hoverElev)

      // Vertical crosshair line
      ctx!.beginPath()
      ctx!.setLineDash([3, 3])
      ctx!.moveTo(hx, plotY)
      ctx!.lineTo(hx, plotY + plotH)
      ctx!.strokeStyle = 'rgba(37, 99, 235, 0.5)'
      ctx!.lineWidth = 1
      ctx!.stroke()

      // Horizontal crosshair line
      ctx!.beginPath()
      ctx!.moveTo(plotX, hy)
      ctx!.lineTo(plotX + plotW, hy)
      ctx!.strokeStyle = 'rgba(37, 99, 235, 0.5)'
      ctx!.lineWidth = 1
      ctx!.stroke()

      ctx!.setLineDash([])

      // Hover dot
      ctx!.beginPath()
      ctx!.arc(hx, hy, 4, 0, Math.PI * 2)
      ctx!.fillStyle = '#2563eb'
      ctx!.fill()
      ctx!.beginPath()
      ctx!.arc(hx, hy, 2, 0, Math.PI * 2)
      ctx!.fillStyle = '#fff'
      ctx!.fill()

      // Tooltip
      const distKm = (hoverDist / 1000).toFixed(2)
      const elevM = Math.round(hoverElev)
      const line1 = distKm + ' km'
      const line2 = elevM + ' m n.m.'
      ctx!.font = '11px ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace'
      const tw = Math.max(ctx!.measureText(line1).width, ctx!.measureText(line2).width) + 12
      const th = 32
      let tx = hx + TOOLTIP_OFFSET
      let ty = hy - th - TOOLTIP_OFFSET
      // Keep tooltip within chart bounds
      if (tx + tw > plotX + plotW) tx = hx - tw - TOOLTIP_OFFSET
      if (ty < plotY) ty = hy + TOOLTIP_OFFSET

      ctx!.fillStyle = 'rgba(17, 24, 39, 0.9)'
      ctx!.beginPath()
      ctx!.roundRect(tx, ty, tw, th, 4)
      ctx!.fill()

      ctx!.fillStyle = '#fff'
      ctx!.textAlign = 'left'
      ctx!.textBaseline = 'top'
      ctx!.fillText(line1, tx + 6, ty + 5)
      ctx!.fillStyle = '#9ca3af'
      ctx!.fillText(line2, tx + 6, ty + 18)
    }
  }

  function findClosestPoint(dist: number) {
    const profile = route()?.elevationProfile
    if (!profile || profile.length === 0) return null

    // Binary search for closest distance
    let lo = 0
    let hi = profile.length - 1
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1
      if (profile[mid].distance <= dist) lo = mid
      else hi = mid
    }

    // Pick closer of the two neighbors
    const dLo = Math.abs(profile[lo].distance - dist)
    const dHi = Math.abs(profile[hi].distance - dist)
    return dLo <= dHi ? profile[lo] : profile[hi]
  }

  function onMouseMove(e: MouseEvent) {
    const r = route()
    if (!r?.elevationProfile?.length) return

    const rect = canvas.getBoundingClientRect()
    const mouseX = e.clientX - rect.left
    const plotX = PADDING.left
    const plotW = displayWidth - PADDING.left - PADDING.right

    // Map mouseX to distance
    const ratio = Math.max(0, Math.min(1, (mouseX - plotX) / plotW))
    const dist = ratio * r.elevationProfile[r.elevationProfile.length - 1].distance
    const point = findClosestPoint(dist)

    if (point) {
      setHoveredPoint({ distance: point.distance, elevation: point.elevation })
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => draw(point.distance, point.elevation))
    }
  }

  function onMouseLeave() {
    setHoveredPoint(null)
    cancelAnimationFrame(rafId)
    rafId = requestAnimationFrame(() => draw())
  }

  let initialized = false

  function init() {
    if (!container || !canvas) return
    // If already initialized for THIS canvas element, skip.
    // When <Show> recreates DOM (route cancel → recreate), canvas is a new element
    // and ctx.canvas !== canvas — so we re-initialize.
    if (initialized && ctx?.canvas === canvas) return
    // Clean up old observer if re-initializing
    if (initialized) ro?.disconnect()
    setupCanvas()
    ro = new ResizeObserver(() => {
      setupCanvas()
      draw()
    })
    ro.observe(container)
    canvas.addEventListener('mousemove', onMouseMove)
    canvas.addEventListener('mouseleave', onMouseLeave)
    initialized = true
  }

  onMount(() => {
    // If container/canvas refs are available at mount, initialize now.
    // Otherwise, init() will be called from the route effect when Show renders.
    if (container && canvas) init()
  })

  createEffect(() => {
    route()
    if (container && canvas) init()
    requestAnimationFrame(() => draw())
  })

  onCleanup(() => {
    cancelAnimationFrame(rafId)
    ro?.disconnect()
    if (canvas) {
      canvas.removeEventListener('mousemove', onMouseMove)
      canvas.removeEventListener('mouseleave', onMouseLeave)
    }
  })

  return (
    <Show when={route()?.elevationProfile?.length}>
      <div class="elevation-chart-container" ref={container}>
        <canvas ref={canvas} />
      </div>
    </Show>
  )
}
