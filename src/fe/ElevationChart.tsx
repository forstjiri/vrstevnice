import {createEffect, onCleanup, onMount, Show} from 'solid-js'
import type { ElevationPoint } from '@vrstevnice/shared'
import {computeGeometryDistances, findPositionAtDistance, computeBearing, parseLocalDateTime as parseLocalDateTimeShared, formatLocalDateTime as formatLocalDateTimeShared} from '@vrstevnice/shared'
import { planner } from './appStore'
import { slopeSpeedKmh } from '../routing/index'
import { setHoveredPoint } from './hoverStore'
import {rideAnimation, setCameraTarget, updateRideAnimation} from './rideAnimationStore'
import { effectiveSunDateTime, shadowRouteActive } from './mapControlsStore'
import {
  DEFAULT_ROAD_CLASS_COLOR,
  DEFAULT_SURFACE_COLOR,
  hexToRgba,
  PADDING,
  ROAD_CLASS_COLORS,
  ROAD_CLASS_DASH,
  ROAD_CLASS_LABELS,
  sampleSegmentByDistance,
  sampleValueByDistance,
  SURFACE_COLORS,
  SURFACE_LABELS,
  TOOLTIP_OFFSET
} from './chart-constants'

interface ProfileGroup {
  start: number
  end: number
  color: string
  dash?: number[]
}

export default function ElevationChart() {
  const route = () => planner.route
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
	// Shadow overlay: cached sun exposure per profile point
		let cachedSunExposure: number[] = []	
	// Slope-based cumulative travel times (ms from start)
		let cachedSlopeTimes: number[] = []

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
    const shadowLaneHeight = shadowRouteActive() && cachedSunExposure.length === profile.length ? Math.min(42, plotH * 0.32) : 0
    const profilePlotH = plotH - shadowLaneHeight

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
      return plotY + profilePlotH - ((elev - minElev) / elevSpan) * profilePlotH
    }

    function shadowToY(exposure: number) {
      const laneTop = plotY + profilePlotH + 2
      const laneBottom = plotY + plotH
      return laneBottom - Math.max(0, Math.min(1, exposure)) * Math.max(1, laneBottom - laneTop)
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

		if (shadowRouteActive() && cachedSunExposure.length === profile.length && shadowLaneHeight > 0) {
			const laneTop = plotY + profilePlotH + 2
			const laneBottom = plotY + plotH
			ctx!.fillStyle = 'rgba(253, 230, 138, 0.10)'
			ctx!.fillRect(plotX, laneTop, plotW, laneBottom - laneTop)
			ctx!.strokeStyle = 'rgba(250, 204, 21, 0.20)'
			ctx!.lineWidth = 1
			ctx!.beginPath()
			ctx!.moveTo(plotX, laneTop)
			ctx!.lineTo(plotX + plotW, laneTop)
			ctx!.moveTo(plotX, (laneTop + laneBottom) / 2)
			ctx!.lineTo(plotX + plotW, (laneTop + laneBottom) / 2)
			ctx!.moveTo(plotX, laneBottom)
			ctx!.lineTo(plotX + plotW, laneBottom)
			ctx!.stroke()

			ctx!.beginPath()
			ctx!.moveTo(toX(profile[0].distance), laneBottom)
			ctx!.lineTo(toX(profile[0].distance), shadowToY(cachedSunExposure[0]))
			for (let i = 1; i < profile.length; i++) {
				ctx!.lineTo(toX(profile[i].distance), shadowToY(cachedSunExposure[i]))
			}
			ctx!.lineTo(toX(profile[profile.length - 1].distance), laneBottom)
			ctx!.closePath()
			ctx!.fillStyle = 'rgba(254, 240, 138, 0.22)'
			ctx!.fill()

			ctx!.beginPath()
			ctx!.moveTo(toX(profile[0].distance), shadowToY(cachedSunExposure[0]))
			for (let i = 1; i < profile.length; i++) {
				ctx!.lineTo(toX(profile[i].distance), shadowToY(cachedSunExposure[i]))
			}
			ctx!.strokeStyle = 'rgba(253, 224, 71, 0.95)'
			ctx!.lineWidth = 2
			ctx!.lineJoin = 'round'
			ctx!.stroke()

			ctx!.textAlign = 'left'
			ctx!.textBaseline = 'middle'
			ctx!.fillStyle = 'rgba(202, 138, 4, 0.95)'
			ctx!.fillText('Slunce', plotX + 4, laneTop + 7)
			ctx!.fillText('100', plotX + 4, laneTop + 18)
			ctx!.fillText('50', plotX + 4, (laneTop + laneBottom) / 2)
			ctx!.fillText('0', plotX + 4, laneBottom - 2)
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

      // Slope-based arrival/elapsed time
      const timeAtPoint = hoverIdx !== undefined && cachedSlopeTimes.length > hoverIdx
        ? cachedSlopeTimes[hoverIdx] : undefined
      const dt = effectiveSunDateTime()
      let timeLine = ''
      if (timeAtPoint !== undefined && timeAtPoint > 0) {
        const base = parseLocalDateTimeShared(dt)
        if (base) {
          const arrival = new Date(base.getTime() + timeAtPoint)
          timeLine = arrival.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })
        } else {
          const totalMin = Math.round(timeAtPoint / 60000)
          timeLine = totalMin < 60 ? `≈ ${totalMin} min` : `≈ ${Math.floor(totalMin / 60)} h ${totalMin % 60} min`
        }
      }
      const hasTime = timeLine !== ''

      // Look up surface and road class at hovered profile index
      const surfLabel = hoverIdx !== undefined ? cachedSurfaceLabels[hoverIdx] : ''
      const rcLabel = hoverIdx !== undefined ? cachedRoadClassLabels[hoverIdx] : ''
      const shadowExposure = hoverIdx !== undefined ? cachedSunExposure[hoverIdx] : undefined
      const shadowLabel = shadowRouteActive() && shadowExposure !== undefined
        ? `slunce ${Math.round(shadowExposure * 100)} %`
        : ''
      const hasMeta = surfLabel || rcLabel || shadowLabel

      ctx!.font = '11px ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace'
      const metaLine = [surfLabel, rcLabel, shadowLabel].filter(Boolean).join(' · ')
      const tw = Math.max(
        ctx!.measureText(line1).width,
        ctx!.measureText(line2).width,
        hasTime ? ctx!.measureText(timeLine).width : 0,
        hasMeta ? ctx!.measureText(metaLine).width + 8 : 0,
      ) + 12
      // Lines: dist + elev + time? + meta? → 2/3/4 rows (each 13px)
      const lineCount = 2 + (hasTime ? 1 : 0) + (hasMeta ? 1 : 0)
      const th = lineCount * 13 + 6
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

      let rowY = ty + 31
      if (hasTime) {
        ctx!.fillStyle = '#f59e0b'
        ctx!.fillText(timeLine, tx + 6, rowY)
        rowY += 13
      }

      if (hasMeta) {
        ctx!.fillStyle = '#d1d5db'
        ctx!.fillText(metaLine, tx + 6, rowY)
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

  /** Map a canvas-relative clientX to cumulative route distance in meters. */
  function distFromClientX(clientX: number): number {
    const rect = canvas.getBoundingClientRect()
    const x = clientX - rect.left
    const plotW = displayWidth - PADDING.left - PADDING.right
    const ratio = Math.max(0, Math.min(1, (x - PADDING.left) / plotW))
    const profile = route()?.elevationProfile
    const total = profile && profile.length ? profile[profile.length - 1].distance : 0
    return ratio * total
  }

  function onMouseMove(e: MouseEvent) {
    // Don't interfere with animation
    if (rideAnimation().playing) return
    const r = route()
    if (!r?.elevationProfile?.length) return

    const result = findClosestPoint(distFromClientX(e.clientX))

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

  let cachedAnimDistances: number[] = []
  let cachedTotalDist = 0

  function getAnimDistances(): number[] {
    const r = route()
    if (!r?.geometry?.length) { cachedAnimDistances = []; cachedTotalDist = 0; return [] }
    if (cachedAnimDistances.length === r.geometry.length) return cachedAnimDistances
    cachedAnimDistances = computeGeometryDistances(r.geometry)
    cachedTotalDist = cachedAnimDistances[cachedAnimDistances.length - 1] ?? 0
    return cachedAnimDistances
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
    const baseStr = effectiveSunDateTime()
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
		if (!r?.elevationProfile?.length) {
			stopAnimation();
			return
		}

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

      // Slope-based variable speed: find slope at current position in elevation profile
      const profile = r.elevationProfile
      const curDist = rideAnimation().currentDistance
      let idx = profile.findIndex(p => p.distance >= curDist)
      if (idx < 0) idx = profile.length - 1
      const slopePct = idx > 0
        ? ((profile[idx].elevation - profile[idx - 1].elevation)
          / (profile[idx].distance - profile[idx - 1].distance)) * 100
        : 0
      const speedMs = slopeSpeedKmh(slopePct) * 1000 / 3600 // km/h → m/s
      const newDistance = curDist + (simulatedDeltaMs / 1000) * speedMs

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
				try {
					(window as any).__fitRouteOverview?.()
				} catch (_) {
				}
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
        const dists = getAnimDistances()
        const pos = findPositionAtDistance(r.geometry, dists, newDistance)
        if (pos) {
          const lookahead = Math.min(newDistance + 50, cachedTotalDist)
          const toPos = findPositionAtDistance(r.geometry, dists, lookahead)
          const bearing = (pos && toPos && !(pos[0] === toPos[0] && pos[1] === toPos[1])) ? computeBearing(pos, toPos) : 0
          setCameraTarget(pos[1], pos[0], bearing, true)
        }
      }

      animLoop()
    })
  }

  const parseAnimDateTime = parseLocalDateTimeShared
  const formatAnimDateTime = formatLocalDateTimeShared

  function onChartClick(e: MouseEvent) {
    const r = route()
    if (!r?.elevationProfile?.length) return

    const dist = distFromClientX(e.clientX)

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
      const dists = getAnimDistances()
      const pos = findPositionAtDistance(r.geometry, dists, dist)
      if (pos) {
        const lookahead = Math.min(dist + 50, cachedTotalDist)
        const toPos = findPositionAtDistance(r.geometry, dists, lookahead)
        const bearing = (toPos && !(pos[0] === toPos[0] && pos[1] === toPos[1])) ? computeBearing(pos, toPos) : 0
        setCameraTarget(pos[1], pos[0], bearing, true)
      }
    }

    // Compute and set datetime at clicked position
    if (animBaseDate || rideAnimation().baseDateTime) {
      const base = animBaseDate
        ? animBaseDate
        : parseAnimDateTime(rideAnimation().baseDateTime ?? '')
      if (base) {
        // Use slope-based cumulative time for accurate datetime at position
        let timeOffsetMs: number
        if (result && cachedSlopeTimes.length > result.index) {
          timeOffsetMs = cachedSlopeTimes[result.index]
        } else {
          // Fallback: uniform speed
          const avgSpeedMs = r.duration > 0 ? r.distance / r.duration : 5.56
          timeOffsetMs = dist / avgSpeedMs
        }
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
    canvas.addEventListener('touchmove', (e: TouchEvent) => {
      if (e.touches.length !== 1) return
      onMouseMove({ clientX: e.touches[0].clientX } as MouseEvent)
    }, { passive: true })
    canvas.addEventListener('touchend', onMouseLeave)
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

    // Pre-compute geometry cumulative distances and per-point lookups
    if (r?.geometry && r?.elevationProfile) {
      cachedGeomDists = computeGeometryDistances(r.geometry)

      const profile = r.elevationProfile
      const segs = r.surfaceSegments ?? []
      const rcs = r.roadClassSegments ?? []

      cachedColorAssignments = sampleSegmentByDistance(profile, cachedGeomDists, segs,
        s => SURFACE_COLORS[s.surface] ?? DEFAULT_SURFACE_COLOR, DEFAULT_SURFACE_COLOR)
      cachedSurfaceLabels = sampleSegmentByDistance(profile, cachedGeomDists, segs,
        s => SURFACE_LABELS[s.surface] ?? s.surface, '')

      cachedRoadClassLabels = sampleSegmentByDistance(profile, cachedGeomDists, rcs,
        s => ROAD_CLASS_LABELS[s.roadClass] ?? s.roadClass, '')
      cachedRoadClassColors = sampleSegmentByDistance(profile, cachedGeomDists, rcs,
        s => ROAD_CLASS_COLORS[s.roadClass] ?? DEFAULT_ROAD_CLASS_COLOR, DEFAULT_ROAD_CLASS_COLOR)
      cachedRoadClassDash = sampleSegmentByDistance(profile, cachedGeomDists, rcs,
        s => ROAD_CLASS_DASH[s.roadClass] ?? undefined, undefined)

      // Shadow profile: interpolate r.shadowProfile to profile points
      const sp = r.shadowProfile ?? []
      cachedSunExposure = sampleValueByDistance(profile, sp,
        sp.map(s => s.sunExposure), 1)

      // Slope-based cumulative travel times
      cachedSlopeTimes = r.slopeBasedTimes ?? []
    } else {
      cachedGeomDists = []
      cachedColorAssignments = []
      cachedSurfaceLabels = []
      cachedRoadClassLabels = []
      cachedRoadClassColors = []
      cachedRoadClassDash = []
      cachedSunExposure = []
      cachedSlopeTimes = []
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
      canvas.removeEventListener('touchmove', onMouseMove as any)
      canvas.removeEventListener('touchend', onMouseLeave)
    }
  })

  return (
    <Show when={route()?.elevationProfile?.length}>
      <div class="sheet-content">
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
    </div>
    </Show>
  )
}
