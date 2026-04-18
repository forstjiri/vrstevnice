import { onMount, onCleanup, createEffect, Show } from 'solid-js'
import type { ElevationPoint } from '@vrstevnice/shared'
import { useApp } from './App'

const PADDING = { top: 8, right: 12, bottom: 22, left: 42 }
const TOOLTIP_OFFSET = 12

const SURFACE_COLORS: Record<string, string> = {
  asphalt: '#9ca3af',
  concrete: '#d1d5db',
  paving_stones: '#c4cace',
  cobblestone: '#92400e',
  gravel: '#c4a35a',
  fine_gravel: '#d4b96a',
  compacted: '#b8a070',
  cycleway: '#ec4899',
  track: '#22c55e',
  trail: '#22c55e',
  ground: '#65a30d',
  dirt: '#a16207',
  unpaved: '#d6d3d1',
  paved: '#9ca3af',
  grass: '#4ade80',
  sand: '#fbbf24',
}

const DEFAULT_SURFACE_COLOR = '#94a3b8'

const SURFACE_LABELS: Record<string, string> = {
  asphalt: 'asfalt',
  concrete: 'beton',
  paving_stones: 'dlažba',
  cobblestone: 'kočičí hlavy',
  gravel: 'štěrk',
  fine_gravel: 'jemný štěrk',
  compacted: 'zhutněný',
  cycleway: 'cyklostezka',
  track: 'polní cesta',
  trail: 'pěšina',
  ground: 'zem',
  dirt: 'hlína',
  unpaved: 'nezpevněno',
  paved: 'zpevněno',
  grass: 'tráva',
  sand: 'písek',
}

const ROAD_CLASS_LABELS: Record<string, string> = {
  MOTORWAY: 'dálnice',
  TRUNK: 'silnice pro motorová vozidla',
  PRIMARY: 'silnice I. třídy',
  SECONDARY: 'silnice II. třídy',
  TERTIARY: 'silnice III. třídy',
  RESIDENTIAL: 'městská komunikace',
  UNCLASSIFIED: 'nezatříděná',
  SERVICE: 'přístupová cesta',
  TRACK: 'polní cesta',
  OTHER: 'jiná',
}

const EARTH_RADIUS_M = 6_371_000

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
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
  const { route, setHoveredPoint } = useApp()
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

  function computeGeometryDistances(geometry: [number, number][]): number[] {
    const dists: number[] = [0]
    for (let i = 1; i < geometry.length; i++) {
      const [lat1, lon1] = geometry[i - 1]
      const [lat2, lon2] = geometry[i]
      dists.push(dists[i - 1] + haversineMeters(lat1, lon1, lat2, lon2))
    }
    return dists
  }

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

      for (const group of groups) {
        // Fill area with gradient for this surface color
        const fillGrad = ctx!.createLinearGradient(0, plotY, 0, plotY + plotH)
        fillGrad.addColorStop(0, hexToRgba(group.color, 0.35))
        fillGrad.addColorStop(1, hexToRgba(group.color, 0.03))

        ctx!.beginPath()
        ctx!.moveTo(toX(profile[group.start].distance), toY(profile[group.start].elevation))
        for (let j = group.start + 1; j <= group.end; j++) {
          ctx!.lineTo(toX(profile[j].distance), toY(profile[j].elevation))
        }
        ctx!.lineTo(toX(profile[group.end].distance), plotY + plotH)
        ctx!.lineTo(toX(profile[group.start].distance), plotY + plotH)
        ctx!.closePath()
        ctx!.fillStyle = fillGrad
        ctx!.fill()

        // Stroke line for this surface
        ctx!.beginPath()
        ctx!.moveTo(toX(profile[group.start].distance), toY(profile[group.start].elevation))
        for (let j = group.start + 1; j <= group.end; j++) {
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

      if (r.surfaceSegments && r.surfaceSegments.length > 0) {
        const assignments: string[] = []
        const surfLabels: string[] = []
        for (let i = 0; i < r.elevationProfile.length; i++) {
          const dist = r.elevationProfile[i].distance
          let color = DEFAULT_SURFACE_COLOR
          let surfLabel = ''
          for (const seg of r.surfaceSegments) {
            const segStart = cachedGeomDists[seg.from] ?? -Infinity
            const segEnd = cachedGeomDists[seg.to] ?? Infinity
            if (dist >= segStart && dist <= segEnd) {
              color = SURFACE_COLORS[seg.surface] ?? DEFAULT_SURFACE_COLOR
              surfLabel = SURFACE_LABELS[seg.surface] ?? seg.surface
              break
            }
          }
          assignments.push(color)
          surfLabels.push(surfLabel)
        }
        cachedColorAssignments = assignments
        cachedSurfaceLabels = surfLabels
      } else {
        cachedColorAssignments = []
        cachedSurfaceLabels = []
      }

      if (r.roadClassSegments && r.roadClassSegments.length > 0) {
        const rcLabels: string[] = []
        for (let i = 0; i < r.elevationProfile.length; i++) {
          const dist = r.elevationProfile[i].distance
          let rcLabel = ''
          for (const seg of r.roadClassSegments) {
            const segStart = cachedGeomDists[seg.from] ?? -Infinity
            const segEnd = cachedGeomDists[seg.to] ?? Infinity
            if (dist >= segStart && dist <= segEnd) {
              rcLabel = ROAD_CLASS_LABELS[seg.roadClass] ?? seg.roadClass
              break
            }
          }
          rcLabels.push(rcLabel)
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
