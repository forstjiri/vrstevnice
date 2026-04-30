import { onMount, onCleanup, createEffect, Show } from 'solid-js'
import type { ElevationPoint } from '@vrstevnice/shared'
import { haversineMeters, computeGeometryDistances } from '@vrstevnice/shared'
import { useApp } from './App'
import { setHoveredPoint } from './hoverStore'
import { PADDING, TOOLTIP_OFFSET, SURFACE_COLORS, DEFAULT_SURFACE_COLOR, SURFACE_LABELS, ROAD_CLASS_LABELS } from './chart-constants'

/**
 * Binary search for the segment containing a given distance.
 * Returns segment index, or -1 if no segment matches.
 * O(log n) per lookup instead of O(n) linear scan.
 */
function binarySearchSegment(
  segStarts: number[],
  segEnds: number[],
  dist: number,
): number {
  let lo = 0
  let hi = segStarts.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (dist < segStarts[mid]) { hi = mid - 1; continue }
    if (dist > segEnds[mid]) { lo = mid + 1; continue }
    return mid
  }
  return -1
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

interface ProfileGroup {
  start: number
  end: number
  color: string
}

export default function ElevationChart() {
  const { route } = useApp()
  let container!: HTMLDivElement
  let canvas!: HTMLCanvasElement
  let ctx: CanvasRenderingContext2D | null = null
  let dpr = 1
  let displayWidth = 0
  let displayHeight = 0
  let ro: ResizeObserver | null = null
  let rafId = 0

  // Cached per-route surface coloring data (recomputed when route changes)
  let cachedGeomDists: number[] = []
  let cachedColorAssignments: string[] = []
  // Per-profile-point surface and road class labels (for tooltip)
  let cachedSurfaceLabels: string[] = []
  let cachedRoadClassLabels: string[] = []

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

  function draw(hoverDist?: number, hoverElev?: number, hoverIdx?: number) {
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

    // Draw elevation profile — per-surface colored or fallback blue
    const useSurfaceColors = cachedColorAssignments.length === profile.length

    if (!useSurfaceColors) {
      // Original blue gradient fill
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

      // Blue stroke
      ctx!.beginPath()
      ctx!.moveTo(toX(profile[0].distance), toY(profile[0].elevation))
      for (let i = 1; i < profile.length; i++) {
        ctx!.lineTo(toX(profile[i].distance), toY(profile[i].elevation))
      }
      ctx!.strokeStyle = '#2563eb'
      ctx!.lineWidth = 1.5
      ctx!.lineJoin = 'round'
      ctx!.stroke()
    } else {
      // Group consecutive profile points with the same surface color
      const groups: ProfileGroup[] = []
      let gi = 0
      while (gi < profile.length) {
        const color = cachedColorAssignments[gi]
        const start = gi
        while (gi < profile.length && cachedColorAssignments[gi] === color) gi++
        groups.push({ start, end: gi - 1, color })
      }

      for (let gi = 0; gi < groups.length; gi++) {
        const group = groups[gi]
        // Include previous group's last point for seamless continuity
        const drawStart = gi > 0 ? groups[gi - 1].end : group.start

        // Fill area with gradient for this surface color
        const fillGrad = ctx!.createLinearGradient(0, plotY, 0, plotY + plotH)
        fillGrad.addColorStop(0, hexToRgba(group.color, 0.35))
        fillGrad.addColorStop(1, hexToRgba(group.color, 0.03))

        ctx!.beginPath()
        ctx!.moveTo(toX(profile[drawStart].distance), toY(profile[drawStart].elevation))
        for (let j = drawStart + 1; j <= group.end; j++) {
          ctx!.lineTo(toX(profile[j].distance), toY(profile[j].elevation))
        }
        ctx!.lineTo(toX(profile[group.end].distance), plotY + plotH)
        ctx!.lineTo(toX(profile[drawStart].distance), plotY + plotH)
        ctx!.closePath()
        ctx!.fillStyle = fillGrad
        ctx!.fill()

        // Stroke line for this surface
        ctx!.beginPath()
        ctx!.moveTo(toX(profile[drawStart].distance), toY(profile[drawStart].elevation))
        for (let j = drawStart + 1; j <= group.end; j++) {
          ctx!.lineTo(toX(profile[j].distance), toY(profile[j].elevation))
        }
        ctx!.strokeStyle = group.color
        ctx!.lineWidth = 1.5
        ctx!.lineJoin = 'round'
        ctx!.stroke()
      }
    }

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

      // Look up surface and road class at hovered profile index
      const surfLabel = hoverIdx !== undefined ? cachedSurfaceLabels[hoverIdx] : ''
      const rcLabel = hoverIdx !== undefined ? cachedRoadClassLabels[hoverIdx] : ''
      const hasMeta = surfLabel || rcLabel

      ctx!.font = '11px ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace'
      const tw = Math.max(
        ctx!.measureText(line1).width,
        ctx!.measureText(line2).width,
        hasMeta ? ctx!.measureText(surfLabel + ' · ' + rcLabel).width + 8 : 0,
      ) + 12
      const th = hasMeta ? 44 : 32
      let tx = hx + TOOLTIP_OFFSET
      let ty = hy - th - TOOLTIP_OFFSET
      // Keep tooltip within chart bounds
      if (tx + tw > plotX + plotW) tx = hx - tw - TOOLTIP_OFFSET
      if (ty < plotY) ty = hy + TOOLTIP_OFFSET

      ctx!.fillStyle = 'rgba(17, 24, 39, 0.9)'
      ctx!.beginPath()
      ctx!.roundRect(tx, ty, tw, th, 4)
      ctx!.fill()

      ctx!.textAlign = 'left'
      ctx!.textBaseline = 'top'
      ctx!.fillStyle = '#fff'
      ctx!.fillText(line1, tx + 6, ty + 5)
      ctx!.fillStyle = '#9ca3af'
      ctx!.fillText(line2, tx + 6, ty + 18)

      if (hasMeta) {
        const metaLine = [surfLabel, rcLabel].filter(Boolean).join(' · ')
        ctx!.fillStyle = '#d1d5db'
        ctx!.fillText(metaLine, tx + 6, ty + 31)
      }
    }
  }

  function findClosestPoint(dist: number): { point: ElevationPoint; index: number } | null {
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
    const idx = dLo <= dHi ? lo : hi
    return { point: profile[idx], index: idx }
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
    const result = findClosestPoint(dist)

    if (result) {
      setHoveredPoint({ distance: result.point.distance, elevation: result.point.elevation })
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => draw(result.point.distance, result.point.elevation, result.index))
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
    const r = route()
    if (container && canvas) init()

    // Pre-compute geometry cumulative distances and surface color assignments
    if (r?.geometry && r?.elevationProfile) {
      cachedGeomDists = computeGeometryDistances(r.geometry)

      // Build lookup arrays for binary search: segment start distances keyed by sort order
      if (r.surfaceSegments && r.surfaceSegments.length > 0) {
        const segStarts = r.surfaceSegments.map(s => cachedGeomDists[s.from] ?? -Infinity)
        const segEnds = r.surfaceSegments.map(s => cachedGeomDists[s.to] ?? Infinity)
        const assignments: string[] = []
        const surfLabels: string[] = []
        for (let i = 0; i < r.elevationProfile.length; i++) {
          const dist = r.elevationProfile[i].distance
          const idx = binarySearchSegment(segStarts, segEnds, dist)
          if (idx >= 0) {
            assignments.push(SURFACE_COLORS[r.surfaceSegments[idx].surface] ?? DEFAULT_SURFACE_COLOR)
            surfLabels.push(SURFACE_LABELS[r.surfaceSegments[idx].surface] ?? r.surfaceSegments[idx].surface)
          } else {
            assignments.push(DEFAULT_SURFACE_COLOR)
            surfLabels.push('')
          }
        }
        cachedColorAssignments = assignments
        cachedSurfaceLabels = surfLabels
      } else {
        cachedColorAssignments = []
        cachedSurfaceLabels = []
      }

      if (r.roadClassSegments && r.roadClassSegments.length > 0) {
        const rcSegStarts = r.roadClassSegments.map(s => cachedGeomDists[s.from] ?? -Infinity)
        const rcSegEnds = r.roadClassSegments.map(s => cachedGeomDists[s.to] ?? Infinity)
        const rcLabels: string[] = []
        for (let i = 0; i < r.elevationProfile.length; i++) {
          const dist = r.elevationProfile[i].distance
          const idx = binarySearchSegment(rcSegStarts, rcSegEnds, dist)
          if (idx >= 0) {
            rcLabels.push(ROAD_CLASS_LABELS[r.roadClassSegments[idx].roadClass] ?? r.roadClassSegments[idx].roadClass)
          } else {
            rcLabels.push('')
          }
        }
        cachedRoadClassLabels = rcLabels
      } else {
        cachedRoadClassLabels = []
      }
    } else {
      cachedGeomDists = []
      cachedColorAssignments = []
      cachedSurfaceLabels = []
      cachedRoadClassLabels = []
    }

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
