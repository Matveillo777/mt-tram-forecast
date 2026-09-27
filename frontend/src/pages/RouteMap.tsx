import { useEffect, useRef, useState } from 'react'
import {
  AttributionControl,
  Map as MlMap,
  NavigationControl,
  Popup,
  setWorkerUrl,
  type GeoJSONSource,
  type MapLayerMouseEvent,
  type StyleSpecification,
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { useApp, type Palette } from '../theme'
import { fmt } from '../format'

setWorkerUrl(workerUrl)

type Props = Record<string, string | number | boolean | null>
export interface Geo {
  type: 'FeatureCollection'
  features: { type: 'Feature'; geometry: { type: string; coordinates: unknown }; properties: Props }[]
}
export interface Selection {
  route: number
  stop?: { id: string; name: string }
}

const BASEMAP = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
}

// used when the tile server is unreachable: plain background, our layers still work
const fallbackStyle = (p: Palette): StyleSpecification => ({
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': p.surface2 } }],
})

function bounds(geo: Geo): [[number, number], [number, number]] | null {
  let w = 180, s = 90, e = -180, n = -90
  const walk = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === 'number') {
      const [x, y] = c as number[]
      w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y)
    } else if (Array.isArray(c)) c.forEach(walk)
  }
  geo.features.forEach((f) => walk(f.geometry.coordinates))
  return w <= e ? [[w, s], [e, n]] : null
}

export function RouteMap({ geo, values, max, visible, selection, onSelect }: {
  geo: Geo
  values?: Map<string, number>
  max: number
  visible: number[]
  selection: Selection | null
  onSelect: (s: Selection) => void
}) {
  const { palette, theme } = useApp()
  const box = useRef<HTMLDivElement>(null)
  const map = useRef<MlMap | null>(null)
  const [ready, setReady] = useState(0)
  const [offline, setOffline] = useState(false)
  // handlers registered once read the latest props through this ref
  const latest = useRef({ values, onSelect, palette, geo })
  latest.current = { values, onSelect, palette, geo }

  useEffect(() => {
    const b = bounds(geo)
    const m = new MlMap({
      container: box.current!,
      style: BASEMAP[theme],
      center: [37.62, 55.75],
      zoom: 10,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      ...(b ? { bounds: b, fitBoundsOptions: { padding: 40 } } : {}),
    })
    m.touchZoomRotate.disableRotation()
    m.addControl(new NavigationControl({ showCompass: false }), 'top-right')
    m.addControl(new AttributionControl({ compact: true }), 'bottom-right')
    map.current = m

    let styleLoaded = false
    m.on('style.load', () => {
      styleLoaded = true
      russianLabels(m)
      addLayers(m)
      setReady((n) => n + 1)
    })
    m.on('error', () => {
      if (!styleLoaded) {
        setOffline(true)
        m.setStyle(fallbackStyle(latest.current.palette))
      }
    })

    const popup = new Popup({ closeButton: false, closeOnClick: false, offset: 10, maxWidth: '260px' })
    m.on('mousemove', 'stops', (e: MapLayerMouseEvent) => {
      const f = e.features?.[0]
      if (!f) return
      m.getCanvas().style.cursor = 'pointer'
      const p = f.properties as Props
      const v = latest.current.values?.get(p.route + ':' + p.stop_id)
      const el = document.createElement('div')
      el.className = 'pop-stop'
      const name = document.createElement('b')
      name.textContent = String(p.name)
      const sub = document.createElement('span')
      sub.textContent = `маршрут ${p.route} · ${v == null ? 'нет данных' : fmt(v) + ' посадок в час'}`
      el.append(name, sub)
      popup.setLngLat(e.lngLat).setDOMContent(el).addTo(m)
    })
    m.on('mouseleave', 'stops', () => {
      m.getCanvas().style.cursor = ''
      popup.remove()
    })
    m.on('mouseenter', 'routes-hit', () => (m.getCanvas().style.cursor = 'pointer'))
    m.on('mouseleave', 'routes-hit', () => (m.getCanvas().style.cursor = ''))
    m.on('click', (e) => {
      const hits = m.queryRenderedFeatures(e.point, { layers: ['stops', 'routes-hit'] })
      const stop = hits.find((f) => f.layer.id === 'stops')
      const f = stop ?? hits[0]
      if (!f) return
      const p = f.properties as Props
      latest.current.onSelect(
        stop ? { route: Number(p.route), stop: { id: String(p.stop_id), name: String(p.name) } } : { route: Number(p.route) },
      )
    })

    return () => {
      popup.remove()
      m.remove()
      map.current = null
    }
    // created once; geometry, theme and filters are applied by the effects below
  }, [])

  // basemap follows the theme
  const firstTheme = useRef(theme)
  useEffect(() => {
    if (theme === firstTheme.current) return
    firstTheme.current = theme
    map.current?.setStyle(offline ? fallbackStyle(palette) : BASEMAP[theme], { diff: false })
  }, [theme])

  // data: geometry with colors and current values baked into feature properties
  useEffect(() => {
    const m = map.current
    const src = m?.getSource('net') as GeoJSONSource | undefined
    if (!m || !src) return
    const features = geo.features.map((f) => {
      const r = Number(f.properties.route)
      const c = palette.route(r)
      if (f.geometry.type === 'Point') {
        const v = values?.get(r + ':' + f.properties.stop_id) ?? 0
        return { ...f, properties: { ...f.properties, c, v, n: max > 0 ? Math.min(1, v / max) : 0 } }
      }
      return { ...f, properties: { ...f.properties, c } }
    })
    src.setData({ type: 'FeatureCollection', features } as never)
  }, [ready, geo, values, max, palette])

  // paint that depends on the palette, filters and selection
  useEffect(() => {
    const m = map.current
    if (!m || !m.getLayer('stops')) return
    const vis = ['in', ['get', 'route'], ['literal', visible]]
    const sel = selection?.route ?? -1
    const dim = selection && !selection.stop
    m.setFilter('routes', ['all', LINES, vis] as never)
    m.setFilter('routes-hit', ['all', LINES, vis] as never)
    m.setFilter('stops', ['all', POINTS, vis] as never)
    m.setFilter('stop-sel', ['all', POINTS, ['==', ['get', 'route'], sel], ['==', ['get', 'stop_id'], selection?.stop?.id ?? '']] as never)
    m.setPaintProperty('routes', 'line-opacity', dim ? ['case', ['==', ['get', 'route'], sel], 1, 0.25] : 0.9)
    m.setPaintProperty('routes', 'line-width', dim ? ['case', ['==', ['get', 'route'], sel], 5, 3] : ['interpolate', ['linear'], ['zoom'], 10, 3.5, 14, 6])
    m.setPaintProperty('stops', 'circle-opacity', dim ? ['case', ['==', ['get', 'route'], sel], 1, 0.35] : 1)
    m.setPaintProperty('stops', 'circle-color', ['interpolate', ['linear'], ['get', 'n'], 0, palette.load[0], 0.5, palette.load[1], 1, palette.load[2]])
    m.setPaintProperty('stops', 'circle-stroke-color', palette.surface1)
    m.setPaintProperty('stop-sel', 'circle-stroke-color', palette.text1)
  }, [ready, visible, selection, palette])

  return (
    <>
      <div ref={box} style={{ position: 'absolute', inset: 0 }} />
      {ready === 0 && !offline && (
        <div className="map-wait">
          <span className="badge">Загружаем карту</span>
        </div>
      )}
      {offline && (
        <div className="map-overlay map-offline">
          <span className="badge">Подложка недоступна, показаны только маршруты</span>
        </div>
      )}
    </>
  )
}

// area follows the value, size also grows with zoom so dense stops do not merge when zoomed out
const radius = (extra: number) => {
  const r = (a: number, b: number) => ['+', a + extra, ['*', b - a, ['sqrt', ['get', 'n']]]]
  return ['interpolate', ['linear'], ['zoom'], 9, r(1, 4), 12, r(2, 10), 15, r(3.5, 18)] as never
}

// stops carry stop_id, route lines do not
const POINTS = ['has', 'stop_id'] as never
const LINES = ['!', ['has', 'stop_id']] as never

// the basemap signs places in two languages, the interface is Russian only
function russianLabels(m: MlMap) {
  for (const l of m.getStyle().layers) {
    if (l.type !== 'symbol') continue
    const tf = m.getLayoutProperty(l.id, 'text-field')
    if (tf && JSON.stringify(tf).includes('name')) m.setLayoutProperty(l.id, 'text-field', ['coalesce', ['get', 'name:ru'], ['get', 'name']])
  }
}

function addLayers(m: MlMap) {
  if (m.getSource('net')) return
  m.addSource('net', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  m.addLayer({
    id: 'routes',
    type: 'line',
    source: 'net',
    filter: LINES,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'c'], 'line-width': 3, 'line-opacity': 0.9 },
  })
  m.addLayer({
    id: 'routes-hit',
    type: 'line',
    source: 'net',
    filter: LINES,
    paint: { 'line-color': '#1f1d1a', 'line-width': 14, 'line-opacity': 0 },
  })
  m.addLayer({
    id: 'stops',
    type: 'circle',
    source: 'net',
    filter: POINTS,
    // big circles underneath, small ones stay clickable on top
    layout: { 'circle-sort-key': ['-', 0, ['get', 'n']] },
    paint: {
      'circle-radius': radius(0),
      'circle-color': '#e0874f',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 0.75, 13, 1.5],
      'circle-stroke-color': '#faf9f6',
      'circle-radius-transition': { duration: 200, delay: 0 },
      'circle-color-transition': { duration: 200, delay: 0 },
    },
  })
  m.addLayer({
    id: 'stop-sel',
    type: 'circle',
    source: 'net',
    filter: ['==', ['get', 'stop_id'], ''],
    paint: {
      'circle-radius': radius(4),
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-width': 2.5,
      'circle-stroke-color': '#1f1d1a',
    },
  })
}
