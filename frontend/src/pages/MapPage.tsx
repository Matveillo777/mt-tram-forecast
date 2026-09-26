import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { getJson, errorText, useApi, type ForecastResp, type HistoryResp, type MapResp } from '../api'
import { baseOption, bandSeries, lineSeries, tipHead, tipRow, EChart } from '../chart'
import { compact, dateLong, dateWithDay, fmt, hh } from '../format'
import { Icon } from '../icons'
import { useApp } from '../theme'
import { Busy, DateStepper, Empty, ErrorState, Legend, Loading, RouteDot } from '../ui'
import { RouteMap, type Geo, type Selection } from './RouteMap'

const HOURS = Array.from({ length: 24 }, (_, h) => h)

/** All 24 hourly snapshots of one date, so the hour animation never waits for the network. */
function useDayMap(date: string) {
  const [state, setState] = useState<{ date: string; hours?: MapResp[]; error?: string }>({ date })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const ctl = new AbortController()
    setState((s) => ({ date, hours: s.hours }))
    Promise.all(HOURS.map((hour) => getJson<MapResp>('/map', { date, hour }, ctl.signal))).then(
      (hours) => setState({ date, hours }),
      (e) => !ctl.signal.aborted && setState({ date, error: errorText(e) }),
    )
    return () => ctl.abort()
  }, [date, tick])
  return { ...state, loading: state.date !== date || (!state.hours && !state.error), reload: () => setTick((t) => t + 1) }
}

export default function MapPage() {
  const { meta, routeName, palette } = useApp()
  const [date, setDate] = useState(meta.today)
  const [hour, setHour] = useState(8)
  const [playing, setPlaying] = useState(false)
  const [only, setOnly] = useState<number[]>([])
  const [sel, setSel] = useState<Selection | null>(null)

  const geo = useApi<Geo>('/routes/geojson')
  const day = useDayMap(date)
  const isHistory = date <= meta.history_to
  const visible = only.length ? only : meta.routes

  // on narrow screens the panel sits under the map, bring it into view
  const side = useRef<HTMLElement>(null)
  useEffect(() => {
    if (sel && matchMedia('(max-width: 960px)').matches) side.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [sel])

  useEffect(() => {
    if (!playing) return
    const t = setInterval(() => setHour((h) => (h + 1) % 24), 1100)
    return () => clearInterval(t)
  }, [playing])

  // value per stop and per route for every hour of the day
  const cube = useMemo(() => {
    if (!day.hours) return null
    const stops = day.hours.map((m) => {
      const out = new Map<string, number>()
      for (const r of m.routes) for (const s of r.stops) out.set(r.route + ':' + s.stop_id, s.value)
      return out
    })
    const routes = day.hours.map((m) => new Map(m.routes.map((r) => [r.route, r.value])))
    // scale by the 98th percentile: a couple of hub stops would otherwise make every other stop look empty
    const all = stops.flatMap((m) => [...m.values()].filter((v) => v > 0)).sort((a, b) => a - b)
    const max = all.length ? all[Math.floor(all.length * 0.98)] : 0
    return { stops, routes, max }
  }, [day.hours])

  const onMap = useMemo(() => {
    const s = new Set<number>()
    for (const f of geo.data?.features ?? []) if (f.geometry.type !== 'Point') s.add(f.properties.route as number)
    return s
  }, [geo.data])

  const hourTotals = HOURS.map((h) => visible.reduce((a, r) => a + (cube?.routes[h].get(r) ?? 0), 0))
  const hourMax = Math.max(1, ...hourTotals)
  const routeRows = visible
    .map((r) => ({ route: r, value: cube?.routes[hour].get(r) ?? 0 }))
    .sort((a, b) => b.value - a.value || a.route - b.route)
  const routeMax = Math.max(1, ...routeRows.map((r) => r.value))

  // with all routes shown, a click isolates one route; after that clicks add or remove routes
  const toggleRoute = (r: number) => {
    const next = only.length === 0 ? [r] : only.includes(r) ? only.filter((x) => x !== r) : [...only, r]
    setOnly(next.length === meta.routes.length ? [] : next)
    if (sel && next.length && !next.includes(sel.route)) setSel(null)
  }

  const kind = isHistory ? 'Факт' : 'Прогноз'

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Карта загрузки</h1>
          <p>Посадки на остановках за выбранный час. До {dateLong(meta.history_to)} показан факт по валидациям, дальше прогноз модели.</p>
        </div>
        <div className="toolbar">
          <DateStepper value={date} onChange={setDate} min={meta.history_from} max={meta.forecast_to} label="Дата" />
          <span className={'badge' + (isHistory ? '' : ' signal')}>
            <Icon name={isHistory ? 'history' : 'forecast'} size={16} />
            {kind}
          </span>
          {date !== meta.today && (
            <button type="button" className="btn btn-ghost" onClick={() => setDate(meta.today)}>
              Сегодня
            </button>
          )}
        </div>
      </div>

      <div className="chips" role="group" aria-label="Маршруты на карте">
        <button type="button" className="chip" aria-pressed={only.length === 0} onClick={() => setOnly([])}>
          Все
        </button>
        {meta.routes.map((r) => (
          <button
            type="button"
            key={r}
            className="chip"
            aria-pressed={visible.includes(r)}
            title={routeName(r)}
            onClick={() => toggleRoute(r)}
            style={{ '--c': palette.route(r) } as CSSProperties}
          >
            <span className="dot" />
            <b>{r}</b>
          </button>
        ))}
      </div>

      <div className="map-layout">
        <div className="card map-card">
          <div className="map-box">
            {geo.error ? (
              <ErrorState message={geo.error} onRetry={geo.reload} height={420} />
            ) : !geo.data ? (
              <Loading height={420} label="Загружаем схему маршрутов" />
            ) : (
              <RouteMap
                geo={geo.data}
                values={cube?.stops[hour]}
                max={cube?.max ?? 1}
                visible={visible}
                selection={sel}
                onSelect={setSel}
              />
            )}
            <div className="map-overlay map-status">
              <span className="badge">
                {kind} · {dateWithDay(date)}, {hh(hour)}
              </span>
              {day.loading && <span className="badge"><span className="spinner" /> обновляем</span>}
            </div>
            {cube && <MapLegend max={cube.max} />}
          </div>
          {day.error && (
            <div className="map-error">
              <ErrorState message={day.error} onRetry={day.reload} height={120} />
            </div>
          )}
          <div className="timeline">
            <button
              type="button"
              className="btn btn-icon play"
              aria-label={playing ? 'Пауза' : 'Показать динамику за сутки'}
              aria-pressed={playing}
              onClick={() => setPlaying((p) => !p)}
            >
              <Icon name={playing ? 'pause' : 'play'} size={18} />
            </button>
            <div className="clock">{hh(hour)}</div>
            <div className="tl-body">
              <div className="tl-bars" role="group" aria-label="Час суток">
                {HOURS.map((h) => (
                  <button
                    type="button"
                    key={h}
                    aria-current={h === hour}
                    aria-label={`${hh(h)}, ${fmt(hourTotals[h])} посадок`}
                    title={`${hh(h)} · ${fmt(hourTotals[h])}`}
                    style={{ height: cube ? Math.max(3, (hourTotals[h] / hourMax) * 36) : 3 }}
                    onClick={() => {
                      setPlaying(false)
                      setHour(h)
                    }}
                  />
                ))}
              </div>
              <div className="tl-ticks">
                <span>00</span>
                <span>06</span>
                <span>12</span>
                <span>18</span>
                <span>23</span>
              </div>
            </div>
          </div>
        </div>

        <aside className="side" ref={side}>
          {sel ? (
            <DetailPanel sel={sel} date={date} hour={hour} isHistory={isHistory} onClose={() => setSel(null)} onHour={setHour} />
          ) : (
            <div className="card">
              <div className="card-head">
                <h2>Маршруты в {hh(hour)}</h2>
                <span className="hint num">{fmt(hourTotals[hour])} посадок</span>
              </div>
              <Busy busy={day.loading}>
                <div className="route-list">
                  {routeRows.map(({ route, value }) => (
                    <button
                      type="button"
                      key={route}
                      className="route-row"
                      style={{ '--c': palette.route(route) } as CSSProperties}
                      onClick={() => setSel({ route })}
                    >
                      <span className="dot" />
                      <span className="no">{route}</span>
                      <span className="nm" title={routeName(route)}>
                        {routeName(route)}
                        {!onMap.has(route) && ' · нет на карте'}
                      </span>
                      <span className="val">{cube ? fmt(value) : '-'}</span>
                      <span className="bar"><i style={{ width: (value / routeMax) * 100 + '%' }} /></span>
                    </button>
                  ))}
                </div>
              </Busy>
              <p className="note" style={{ marginTop: 12 }}>Нажмите на остановку или линию на карте, чтобы увидеть почасовой график.</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}

function MapLegend({ max }: { max: number }) {
  const { palette } = useApp()
  const steps = [0.1, 0.5, 1].map((k) => ({ v: max * k, last: k === 1, r: 2.5 + 7.5 * Math.sqrt(k), c: k < 0.3 ? palette.load[0] : k < 0.8 ? palette.load[1] : palette.load[2] }))
  return (
    <div className="map-overlay map-legend">
      <span>Посадок в час</span>
      <div className="ramp">
        {steps.map((s) => (
          <span key={s.v} className="ramp-step">
            <i style={{ '--c': s.c, width: s.r * 2, height: s.r * 2 } as CSSProperties} />
            <span className="num">{compact(s.v)}{s.last ? '+' : ''}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

function DetailPanel({ sel, date, hour, isHistory, onClose, onHour }: {
  sel: Selection
  date: string
  hour: number
  isHistory: boolean
  onClose: () => void
  onHour: (h: number) => void
}) {
  const { routeName, palette } = useApp()
  const params = { from: date, to: date, granularity: 'hour', route: sel.route, stop: sel.stop?.id }
  const fc = useApi<ForecastResp>(isHistory ? null : '/forecast', params)
  const hist = useApi<HistoryResp>(isHistory ? '/history' : null, params)
  const res = isHistory ? hist : fc

  const values = useMemo(() => {
    const out: number[] = new Array(24).fill(0)
    if (isHistory) for (const p of hist.data?.series ?? []) out[Number(p.t.slice(11, 13))] = p.actual
    else for (const p of fc.data?.series ?? []) out[Number(p.t.slice(11, 13))] = p.p50
    return out
  }, [isHistory, hist.data, fc.data])
  const total = values.reduce((a, b) => a + b, 0)
  const peak = values.indexOf(Math.max(...values))

  const option = useMemo(() => {
    const o = baseOption(palette, true)
    const x = HOURS.map((h) => String(h).padStart(2, '0'))
    const series: unknown[] = []
    if (!isHistory && fc.data) {
      const lo = new Array(24).fill(null)
      const hi = new Array(24).fill(null)
      for (const p of fc.data.series) {
        const h = Number(p.t.slice(11, 13))
        lo[h] = p.p10
        hi[h] = p.p90
      }
      series.push(...bandSeries('Интервал p10-p90', lo, hi, palette.forecast))
    }
    const color = isHistory ? palette.fact : palette.forecast
    series.push(
      lineSeries(isHistory ? 'Факт' : 'Прогноз', values, color, {
        markLine: {
          silent: true,
          symbol: 'none',
          label: { show: false },
          lineStyle: { color: palette.accent, width: 1.5, type: 'solid' },
          data: [{ xAxis: x[hour] }],
        },
      }),
    )
    return {
      ...o,
      grid: { ...(o.grid as object), top: 12 },
      xAxis: { ...(o.xAxis as object), data: x, axisLabel: { ...(o.xAxis as { axisLabel: object }).axisLabel, interval: 5 } },
      tooltip: {
        ...(o.tooltip as object),
        formatter: (ps: { dataIndex: number }[]) => {
          const h = ps[0]?.dataIndex ?? 0
          let s = tipHead(hh(h), palette.text3) + tipRow(color, isHistory ? 'Факт' : 'Прогноз', fmt(values[h]))
          if (!isHistory && fc.data) {
            const p = fc.data.series.find((q) => Number(q.t.slice(11, 13)) === h)
            if (p) s += tipRow(color, 'Интервал', `${fmt(p.p10)} - ${fmt(p.p90)}`, 'band')
          }
          return s
        },
      },
      series,
    }
  }, [palette, values, isHistory, fc.data, hour])

  return (
    <div className="card">
      <div className="panel-head">
        <RouteDot route={sel.route} size={12} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2>{sel.stop ? sel.stop.name : `Маршрут ${sel.route}`}</h2>
          <div className="sub">{sel.stop ? `Остановка на маршруте ${sel.route}` : routeName(sel.route)}</div>
        </div>
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Закрыть" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </div>
      {res.error ? (
        <ErrorState message={res.error} onRetry={res.reload} height={260} />
      ) : !res.data ? (
        <Loading height={300} />
      ) : (
        <Busy busy={res.loading}>
          <div className="kv" style={{ margin: '16px 0 8px' }}>
            <div>
              <span>В {hh(hour)}</span>
              <b>{fmt(values[hour])}</b>
            </div>
            <div>
              <span>За сутки</span>
              <b>{fmt(total)}</b>
            </div>
          </div>
          {total > 0 ? (
            <>
              <EChart option={option} height={220} onClick={onHour} />
              <Legend
                items={
                  isHistory
                    ? [{ label: 'Факт, посадок в час', color: palette.fact }]
                    : [
                        { label: 'Прогноз, медиана', color: palette.forecast },
                        { label: 'Интервал p10-p90', color: palette.forecast, kind: 'band' },
                      ]
                }
              />
              <p className="note" style={{ marginTop: 8 }}>Пик в {hh(peak)}. Нажмите на график, чтобы перейти к часу.</p>
            </>
          ) : (
            <Empty text={isHistory ? 'В этот день посадок не было.' : 'Модель не ожидает посадок в этот день.'} height={200} />
          )}
        </Busy>
      )}
    </div>
  )
}
