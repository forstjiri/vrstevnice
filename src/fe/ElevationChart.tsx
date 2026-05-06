import { onMount, onCleanup, createEffect, Show } from 'solid-js'
import type { ElevationPoint } from '@vrstevnice/shared'
import { haversineMeters, computeGeometryDistances } from '@vrstevnice/shared'
import { useApp } from './App'
import { setHoveredPoint } from './hoverStore'
import { rideAnimation, updateRideAnimation, setCameraTarget } from './rideAnimationStore'
import { PADDING, TOOLTIP_OFFSET, SURFACE_COLORS, DEFAULT_SURFACE_COLOR, SURFACE_LABELS, ROAD_CLASS_LABELS, ROAD_CLASS_COLORS, DEFAULT_ROAD_CLASS_COLOR, ROAD_CLASS_DASH, binarySearchSegment, hexToRgba } from './chart-constants'

interface ProfileGroup {
  start: number
  end: number
  color: string
  dash?: number[]
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
  let cachedRoadClassColors: string[] = []
  let cachedRoadClassDash: (number[] | undefined)[] = []

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

    // Draw elevation profile — fill by surface color, stroke by road_class
    const useSurfaceColors = cachedColorAssignments.length === profile.length
    const useRoadClassColors = cachedRoadClassColors.length === profile.length

    if (!useSurfaceColors && !useRoadClassColors) {
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
      // --- FILL PASS: surface-colored gradient fill ---
      if (useSurfaceColors) {
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
          const drawStart = gi > 0 ? groups[gi - 1].end : group.start

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
        }
      } else {
        // Fallback: uniform blue fill
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
      }

      // --- STROKE PASS: road-class colored line ---
      if (useRoadClassColors) {
        // Group consecutive points with same color AND dash pattern
        const groups: ProfileGroup[] = []
        let gi = 0
        while (gi < profile.length) {
          const color = cachedRoadClassColors[gi]
          const dash = cachedRoadClassDash[gi]
          const start = gi
          while (gi < profile.length && cachedRoadClassColors[gi] === color && cachedRoadClassDash[gi] === dash) gi++
          groups.push({ start, end: gi - 1, color, dash })
        }

        for (let gi = 0; gi < groups.length; gi++) {
          const group = groups[gi]
          const drawStart = gi > 0 ? groups[gi - 1].end : group.start

          ctx!.beginPath()
          ctx!.moveTo(toX(profile[drawStart].distance), toY(profile[drawStart].elevation))
          for (let j = drawStart + 1; j <= group.end; j++) {
            ctx!.lineTo(toX(profile[j].distance), toY(profile[j].elevation))
          }
          ctx!.strokeStyle = group.color
          ctx!.lineWidth = 2
          ctx!.lineJoin = 'round'
          if (group.dash) {
            ctx!.setLineDash(group.dash)
          }
          ctx!.stroke()
          if (group.dash) {
            ctx!.setLineDash([])
          }
        }
      } else {
        // Fallback: single-color stroke (use surface color if available)
        ctx!.beginPath()
        ctx!.moveTo(toX(profile[0].distance), toY(profile[0].elevation))
        for (let i = 1; i < profile.length; i++) {
          ctx!.lineTo(toX(profile[i].distance), toY(profile[i].elevation))
        }
        ctx!.strokeStyle = '#2563eb'
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
    // Don't interfere with animation
    if (rideAnimation().playing) return
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

  // ── Ride animation helpers ──

  /**
   * Interpolate position on geometry at given distance.
   * Same logic as findPositionAtDistance in Map.tsx but self-contained.
   */
  function findPositionAtDistanceAnim(
    geometry: [number, number][],
    targetDistance: number,
  ): [number, number] | null {
    if (geometry.length === 0) return null
    if (geometry.length === 1) return geometry[0]
    const totalDist = geometry[geometry.length - 1]
    // Use haversine cumulative distances
    let cumDist = 0
    let prev = geometry[0]
    for (let i = 1; i < geometry.length; i++) {
      const segLen = haversineMeters(prev[0], prev[1], geometry[i][0], geometry[i][1])
      cumDist += segLen
      if (cumDist >= targetDistance) {
        const segStart = cumDist - segLen
        const t = segLen > 0 ? (targetDistance - segStart) / segLen : 0
        return [
          prev[0] + (geometry[i][0] - prev[0]) * t,
          prev[1] + (geometry[i][1] - prev[1]) * t,
        ]
      }
      prev = geometry[i]
    }
    return geometry[geometry.length - 1]
  }

  /**
   * Compute bearing at a given distance along route geometry.
   * Uses a 50m lookahead for direction.
   */
  function computeBearingAnim(
    geometry: [number, number][],
    targetDistance: number,
  ): number {
    const from = findPositionAtDistanceAnim(geometry, targetDistance)
    const to = findPositionAtDistanceAnim(geometry, Math.min(targetDistance + 50, totalRouteDistance()))
    if (!from || !to) return 0
    if (from[0] === to[0] && from[1] === to[1]) return 0
    const toRad = Math.PI / 180
    const toDeg = 180 / Math.PI
    const lat1 = from[0] * toRad
    const lat2 = to[0] * toRad
    const dLng = (to[1] - from[1]) * toRad
    const y = Math.sin(dLng) * Math.cos(lat2)
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
    return ((Math.atan2(y, x) * toDeg) + 360) % 360
  }

  function totalRouteDistance(): number {
    const r = route()
    if (!r?.geometry?.length) return 0
    let total = 0
    let prev = r.geometry[0]
    for (let i = 1; i < r.geometry.length; i++) {
      total += haversineMeters(prev[0], prev[1], r.geometry[i][0], r.geometry[i][1])
      prev = r.geometry[i]
    }
    return total
  }

  // ── Ride animation state ──
  let animRafId = 0
  let animLastTimestamp: number | null = null
  // Base datetime when animation started (from ShadowControls current setting)
  let animBaseDate: Date | null = null

  function startAnimation() {
    const r = route()
    if (!r?.elevationProfile?.length) return

    // Use the current ShadowControls datetime as base
    const baseStr = rideAnimation().currentDateTime
    animBaseDate = baseStr ? parseAnimDateTime(baseStr) : new Date()
    if (!animBaseDate) animBaseDate = new Date()

    // Save base datetime for reset
    const savedBase = formatAnimDateTime(animBaseDate)

    // If starting from end, reset to beginning
    const totalDist = r.elevationProfile[r.elevationProfile.length - 1].distance
    if (rideAnimation().currentDistance >= totalDist) {
      updateRideAnimation({ currentDistance: 0, elapsedMs: 0, baseDateTime: savedBase })
    } else {
      updateRideAnimation({ baseDateTime: savedBase })
    }

    animLastTimestamp = null
    updateRideAnimation({ playing: true })
    animLoop()
  }

  function stopAnimation() {
    updateRideAnimation({ playing: false })
    cancelAnimationFrame(animRafId)
    animLastTimestamp = null
  }

  function resetAnimation() {
    const base = rideAnimation().baseDateTime
    stopAnimation()
    setHoveredPoint(null)
    updateRideAnimation({
      currentDistance: 0,
      elapsedMs: 0,
      currentDateTime: base, // restore original ShadowControls time
      baseDateTime: null,
    })
    cancelAnimationFrame(rafId)
    rafId = requestAnimationFrame(() => draw())
  }

  function animLoop() {
    if (!rideAnimation().playing) return

    const r = route()
    if (!r?.elevationProfile?.length) { stopAnimation(); return }

    animRafId = requestAnimationFrame((timestamp) => {
      if (!rideAnimation().playing) return

      if (animLastTimestamp === null) {
        animLastTimestamp = timestamp
        animLoop()
        return
      }

      const deltaMs = timestamp - animLastTimestamp
      animLastTimestamp = timestamp

      // Convert real elapsed time → simulated time (with speed multiplier)
      const simulatedDeltaMs = deltaMs * rideAnimation().speed
      const newElapsedMs = rideAnimation().elapsedMs + simulatedDeltaMs

      // Convert simulated time → distance (using average speed from route)
      // route.duration is in ms, route.distance in meters
      const avgSpeedMs = r.duration > 0 ? r.distance / r.duration : 5.56 // fallback ~20 km/h
      const newDistance = rideAnimation().currentDistance + simulatedDeltaMs * avgSpeedMs

      const totalDist = r.elevationProfile[r.elevationProfile.length - 1].distance

      if (newDistance >= totalDist) {
        // Reached end — stop and trigger overview
        const base = rideAnimation().baseDateTime
        updateRideAnimation({
          playing: false,
          currentDistance: totalDist,
          elapsedMs: newElapsedMs,
        })
        cancelAnimationFrame(animRafId)
        animLastTimestamp = null
        // Trigger fitBounds via window.__fitRouteOverview
        try { (window as any).__fitRouteOverview?.() } catch (_) {}
        // Reset time to base after a brief delay
        setTimeout(() => {
          updateRideAnimation({
            currentDistance: 0,
            elapsedMs: 0,
            currentDateTime: base, // restore original ShadowControls time
            baseDateTime: null,
          })
          setHoveredPoint(null)
          requestAnimationFrame(() => draw())
        }, 100)
        return
      }

      // Compute current datetime for shadow updates
      if (animBaseDate) {
        const currentDate = new Date(animBaseDate.getTime() + newElapsedMs)
        const dtStr = formatAnimDateTime(currentDate)
        updateRideAnimation({
          currentDistance: newDistance,
          elapsedMs: newElapsedMs,
          currentDateTime: dtStr,
        })
      } else {
        updateRideAnimation({
          currentDistance: newDistance,
          elapsedMs: newElapsedMs,
        })
      }

      // Publish to hoveredPoint for map sync
      const result = findClosestPoint(newDistance)
      if (result) {
        setHoveredPoint({ distance: result.point.distance, elevation: result.point.elevation })
        draw(result.point.distance, result.point.elevation, result.index)
      }

      // Update camera target for smooth camera tracking in Map.tsx
      if (r.geometry?.length) {
        const pos = findPositionAtDistanceAnim(r.geometry, newDistance)
        if (pos) {
          const bearing = computeBearingAnim(r.geometry, newDistance)
          setCameraTarget(pos[1], pos[0], bearing, true)
        }
      }

      animLoop()
    })
  }

  function parseAnimDateTime(value: string): Date | null {
    if (!value) return null
    const [datePart, timePart] = value.split('T')
    if (!datePart || !timePart) return null
    const [year, month, day] = datePart.split('-').map(Number)
    const [hour, minute] = timePart.split(':').map(Number)
    if ([year, month, day, hour, minute].some((n) => Number.isNaN(n))) return null
    return new Date(year, month - 1, day, hour, minute, 0, 0)
  }

  function formatAnimDateTime(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  function onChartClick(e: MouseEvent) {
    const r = route()
    if (!r?.elevationProfile?.length) return

    const rect = canvas.getBoundingClientRect()
    const clickX = e.clientX - rect.left
    const plotX = PADDING.left
    const plotW = displayWidth - PADDING.left - PADDING.right

    // Map clickX to distance
    const ratio = Math.max(0, Math.min(1, (clickX - plotX) / plotW))
    const dist = ratio * r.elevationProfile[r.elevationProfile.length - 1].distance

    // Stop animation if playing
    if (rideAnimation().playing) {
      stopAnimation()
    }

    // Update animation position to clicked distance
    const totalDist = r.elevationProfile[r.elevationProfile.length - 1].distance
    updateRideAnimation({ currentDistance: Math.min(dist, totalDist) })

    // Update hover point and redraw
    const result = findClosestPoint(dist)
    if (result) {
      setHoveredPoint({ distance: result.point.distance, elevation: result.point.elevation })
      draw(result.point.distance, result.point.elevation, result.index)
    }

    // Move camera to clicked position
    if (r.geometry?.length) {
      const pos = findPositionAtDistanceAnim(r.geometry, dist)
      if (pos) {
        const bearing = computeBearingAnim(r.geometry, dist)
        setCameraTarget(pos[1], pos[0], bearing, true)
      }
    }

    // Compute and set datetime at clicked position
    if (animBaseDate || rideAnimation().baseDateTime) {
      const base = animBaseDate
        ? animBaseDate
        : parseAnimDateTime(rideAnimation().baseDateTime ?? '')
      if (base) {
        const avgSpeedMs = r.duration > 0 ? r.distance / r.duration : 5.56
        const timeOffsetMs = (dist / avgSpeedMs)
        const currentDate = new Date(base.getTime() + timeOffsetMs)
        const dtStr = formatAnimDateTime(currentDate)
        updateRideAnimation({ currentDateTime: dtStr })
      }
    }
  }

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
    canvas.addEventListener('click', onChartClick)
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
        const rcColors: string[] = []
        for (let i = 0; i < r.elevationProfile.length; i++) {
          const dist = r.elevationProfile[i].distance
          const idx = binarySearchSegment(rcSegStarts, rcSegEnds, dist)
          if (idx >= 0) {
            const cls = r.roadClassSegments[idx].roadClass
            rcLabels.push(ROAD_CLASS_LABELS[cls] ?? cls)
            rcColors.push(ROAD_CLASS_COLORS[cls] ?? DEFAULT_ROAD_CLASS_COLOR)
          } else {
            rcLabels.push('')
            rcColors.push(DEFAULT_ROAD_CLASS_COLOR)
          }
        }
        const rcDash: (number[] | undefined)[] = []
        for (let i = 0; i < r.elevationProfile.length; i++) {
          const dist = r.elevationProfile[i].distance
          const idx = binarySearchSegment(rcSegStarts, rcSegEnds, dist)
          if (idx >= 0) {
            const cls = r.roadClassSegments[idx].roadClass
            rcDash.push(ROAD_CLASS_DASH[cls] ?? undefined)
          } else {
            rcDash.push(undefined)
          }
        }
        cachedRoadClassLabels = rcLabels
        cachedRoadClassColors = rcColors
        cachedRoadClassDash = rcDash
      } else {
        cachedRoadClassLabels = []
        cachedRoadClassColors = []
        cachedRoadClassDash = []
      }
    } else {
      cachedGeomDists = []
      cachedColorAssignments = []
      cachedSurfaceLabels = []
      cachedRoadClassLabels = []
      cachedRoadClassColors = []
      cachedRoadClassDash = []
    }

    requestAnimationFrame(() => draw())
  })

  onCleanup(() => {
    cancelAnimationFrame(rafId)
    cancelAnimationFrame(animRafId)
    ro?.disconnect()
    if (canvas) {
      canvas.removeEventListener('mousemove', onMouseMove)
      canvas.removeEventListener('mouseleave', onMouseLeave)
      canvas.removeEventListener('click', onChartClick)
    }
  })

  return (
    <Show when={route()?.elevationProfile?.length}>
      <div class="elevation-chart-container" ref={container}>
        <canvas ref={canvas} />
        <div class="ride-animation-controls">
          <button
            class="ride-anim-btn"
            onClick={() => rideAnimation().playing ? stopAnimation() : startAnimation()}
            title={rideAnimation().playing ? 'Pauza' : 'Přehrát'}
          >
            {rideAnimation().playing ? '⏸' : '▶'}
          </button>
          <button
            class="ride-anim-btn"
            onClick={resetAnimation}
            title="Reset"
          >
            ⏮
          </button>
          <label class="ride-anim-speed">
            <span class="ride-anim-speed-label">{rideAnimation().speed}×</span>
            <input
              type="range"
              class="ride-anim-speed-slider"
              min="2"
              max="100"
              step="1"
              value={rideAnimation().speed}
              onInput={(e) => updateRideAnimation({ speed: Number(e.currentTarget.value) })}
            />
          </label>
        </div>
      </div>
    </Show>
  )
}
