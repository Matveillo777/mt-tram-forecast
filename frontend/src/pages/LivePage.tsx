import { useEffect, useMemo, useState } from 'react'
import { API, errorText, postBody, useApi, type LiveResp } from '../api'
import { baseOption, EChart, tipHead, tipRow } from '../chart'
import { dateLong, fmt, hh, pct } from '../format'
import { Icon } from '../icons'
import { useApp } from '../theme'
import { Banner, ErrorState, Legend, Loading, RouteDot, Stat, useNarrow } from '../ui'

type Conn = 'connecting' | 'open' | 'lost'
type LiveRoute = LiveResp['routes'][number]

interface IngestResp {
  accepted: number
  rejected: number
  boardings: number
  errors: string[]
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

// before the first validation the backend reports the epoch, nothing to show then
function clock(iso?: string) {
  const d = new Date(iso ?? '')
  return Number.isNaN(d.getTime()) || d.getFullYear() < 2000 ? '' : d.toLocaleTimeString('ru-RU')
}

export default function LivePage() {
  const { palette } = useApp()
  const narrow = useNarrow()
  const first = useApi<LiveResp>('/live')
  const [snap, setSnap] = useState<LiveResp | null>(null)
  const [conn, setConn] = useState<Conn>('connecting')
  const [route, setRoute] = useState<number | null>(null)

  useEffect(() => {
    const es = new EventSource(API + '/live/stream')
    const on = (e: MessageEvent<string>) => {
      try {
        setSnap(JSON.parse(e.data) as LiveResp)
        setConn('open')
      } catch {
        // a broken frame is skipped, the next one comes in two seconds
      }
    }
    es.addEventListener('snapshot', on)
    es.onmessage = on
    es.onopen = () => setConn('open')
    // EventSource reconnects by itself, we only reflect the state
    es.onerror = () => setConn('lost')
    return () => es.close()
  }, [])

  const data = snap ?? first.data

  const view = useMemo(() => {
    if (!data) return null
    // the demo stream reports its simulated clock; for real ingest the last hour with validations is "now"
    let now = data.sim_time ? Number(data.sim_time.slice(0, 2)) : -1
    if (!data.sim_time) for (const r of data.routes) for (const h of r.hours) if (h.actual > 0) now = Math.max(now, h.hour)
    // the current hour is still filling up, compare on finished hours
    const upTo = now > 0 ? now - 1 : now
    const done = (r: LiveRoute) => r.hours.filter((h) => h.hour <= upTo)
    const rows = data.routes.map((r) => {
      const act = sum(done(r).map((h) => h.actual))
      const fc = sum(done(r).map((h) => h.forecast ?? 0))
      return { r, act, fc, dev: fc > 0 ? (act - fc) / fc : null }
    })
    const act = sum(rows.map((x) => x.act))
    const fc = sum(rows.map((x) => x.fc))
    return {
      now,
      upTo,
      rows,
      dev: fc > 0 ? (act - fc) / fc : null,
      actualAll: sum(data.routes.map((r) => r.actual_total)),
      forecastAll: sum(data.routes.map((r) => r.forecast_total ?? 0)),
    }
  }, [data])

  const option = useMemo(() => {
    if (!data || !view) return null
    const pick = data.routes.filter((r) => route == null || r.route === route)
    const actual = Array.from({ length: 24 }, (_, h) => (h > view.now ? null : sum(pick.map((r) => r.hours.find((x) => x.hour === h)?.actual ?? 0))))
    const forecast = Array.from({ length: 24 }, (_, h) => sum(pick.map((r) => r.hours.find((x) => x.hour === h)?.forecast ?? 0)))
    const o = baseOption(palette, narrow)
    return {
      ...o,
      animation: false,
      xAxis: { ...(o.xAxis as object), boundaryGap: true, data: forecast.map((_, h) => String(h).padStart(2, '0')), axisLabel: { ...(o.xAxis as { axisLabel: object }).axisLabel, interval: narrow ? 5 : 2 } },
      tooltip: {
        ...(o.tooltip as object),
        axisPointer: { type: 'shadow', shadowStyle: { color: palette.surface3, opacity: 0.5 } },
        formatter: (ps: { dataIndex: number }[]) => {
          const h = ps[0]?.dataIndex ?? 0
          return tipHead(hh(h), palette.text3) + tipRow(palette.fact, 'Факт', actual[h] == null ? 'ещё нет' : fmt(actual[h])) + tipRow(palette.forecast, 'Прогноз', fmt(forecast[h]))
        },
      },
      series: [
        { name: 'Факт', type: 'bar', barMaxWidth: 16, data: actual, itemStyle: { color: palette.fact, borderRadius: [3, 3, 0, 0] } },
        { name: 'Прогноз', type: 'line', data: forecast, symbol: 'none', step: 'middle', lineStyle: { color: palette.forecast, width: 2 }, z: 3 },
      ],
    }
  }, [data, view, route, palette, narrow])

  const demo = !!data?.demo

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Онлайн</h1>
          <p>Факт посадок за {data ? dateLong(data.date) : 'текущие сутки'} по мере поступления валидаций, рядом прогноз на те же часы.</p>
        </div>
        <div className="toolbar">
          {demo && <span className="badge">демо-поток</span>}
          <span className={'badge' + (conn === 'open' ? ' live' : conn === 'lost' ? ' signal' : '')}>
            <span className="pulse" />
            {conn === 'open' ? 'поток подключён' : conn === 'lost' ? 'переподключение' : 'подключение'}
          </span>
          {data?.sim_time && <span className="badge num">время в потоке {data.sim_time}</span>}
          {clock(data?.updated_at) && <span className="badge num">обновлено {clock(data?.updated_at)}</span>}
        </div>
      </div>

      {conn === 'lost' && data && <Banner>Связь с потоком прервалась. Показаны последние полученные данные, переподключаемся автоматически.</Banner>}

      {!data || !view || !option ? (
        first.error && conn !== 'open' ? (
          <div className="card"><ErrorState message={first.error} onRetry={first.reload} height={360} /></div>
        ) : (
          <Loading height={420} label="Ждём данные потока" />
        )
      ) : (
        <>
          <div className="stats">
            <Stat label="Посадок с начала суток" value={fmt(view.actualAll)} sub={view.now >= 0 ? `данные по ${hh(view.now)} включительно` : 'валидаций ещё не было'} />
            <Stat
              label="Отклонение от прогноза"
              value={view.dev == null ? '-' : pct(view.dev * 100)}
              sub={view.upTo >= 0 ? `за завершённые часы до ${hh(view.upTo + 1)}` : 'нет завершённых часов'}
              signal={view.dev != null && Math.abs(view.dev) > 0.15}
            />
            <Stat label="Прогноз на сутки" value={fmt(view.forecastAll)} sub="посадок, медиана" />
            <Stat label="Маршрутов в потоке" value={data.routes.filter((r) => r.actual_total > 0).length} sub={`из ${data.routes.length}`} />
          </div>

          <div className="card">
            <div className="card-head">
              <h2>{route == null ? 'Все маршруты' : `Маршрут ${route}`} по часам</h2>
              <div className="row">
                <Legend items={[{ label: 'Факт', color: palette.fact, kind: 'dot' }, { label: 'Прогноз', color: palette.forecast }]} />
                {route != null && (
                  <button type="button" className="btn btn-ghost" onClick={() => setRoute(null)}>
                    Все маршруты
                  </button>
                )}
              </div>
            </div>
            <EChart option={option} height={narrow ? 220 : 280} />
          </div>

          <div className="live-grid">
            {view.rows.map(({ r, act, fc, dev }) => (
              <button type="button" key={r.route} className="live-card" aria-pressed={route === r.route} onClick={() => setRoute(route === r.route ? null : r.route)}>
                <div className="top">
                  <RouteDot route={r.route} />
                  <b>{r.route}</b>
                  <span className={'dev num' + (dev != null && Math.abs(dev) > 0.15 ? ' signal' : '')}>{dev != null ? pct(dev * 100) : r.forecast_total == null ? 'нет прогноза' : 'прогноз 0'}</span>
                </div>
                <div className="nums">
                  <span>факт<b>{fmt(act)}</b></span>
                  <span>прогноз<b>{fmt(fc)}</b></span>
                </div>
                <Spark r={r} now={view.now} />
              </button>
            ))}
          </div>
        </>
      )}

      <Ingest demo={demo} />
    </div>
  )
}

function Spark({ r, now }: { r: LiveRoute; now: number }) {
  const { palette } = useApp()
  const max = Math.max(1, ...r.hours.map((h) => Math.max(h.actual, h.forecast ?? 0)))
  const pts = (key: 'actual' | 'forecast', upTo = 23) =>
    r.hours
      .filter((h) => h.hour <= upTo)
      .map((h) => `${(h.hour / 23) * 240},${34 - ((h[key] ?? 0) / max) * 32}`)
      .join(' ')
  return (
    <svg className="spark" viewBox="0 0 240 36" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts('forecast')} fill="none" stroke={palette.forecast} strokeWidth={1.5} vectorEffect="non-scaling-stroke" opacity={0.7} />
      {now >= 0 && <polyline points={pts('actual', now)} fill="none" stroke={palette.fact} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />}
    </svg>
  )
}

function Ingest({ demo }: { demo: boolean }) {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<IngestResp | null>(null)
  const [error, setError] = useState<string | null>(null)

  const send = async () => {
    if (!file) return
    setError(null)
    setResult(null)
    if (file.size > 10 * 1024 * 1024) {
      setError('Файл больше 10 МБ. Разбейте его на части.')
      return
    }
    setBusy(true)
    try {
      const json = file.name.toLowerCase().endsWith('.json')
      setResult(await postBody<IngestResp>('/ingest/validations', file, json ? 'application/json' : 'text/csv'))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid-2">
      <div className="card">
        <div className="card-head">
          <h2>Откуда берутся данные</h2>
        </div>
        <div className="prose">
          <p>
            Валидации принимаются методом <code>POST /api/v1/ingest/validations</code>: CSV с заголовком как в датасете (разделитель «;») или JSON-массив записей.
            Сервис оставляет успешные проходы (<code>validation_result = 1</code>), берёт номер маршрута из <code>ngpt_route</code>, час из <code>tran_date_time</code> и
            добавляет посадки в счётчики маршрут × час.
          </p>
          {demo && (
            <p>
              Сейчас работает <b>демо-поток</b>: встроенный генератор создаёт записи вокруг прогноза с ускоренными часами (час за 20 секунд) и отправляет их через тот же приём.
            </p>
          )}
        </div>
        <pre className="code" style={{ marginTop: 12 }}>{`curl -X POST ${location.origin}${API}/ingest/validations \\
  -H "Content-Type: text/csv" \\
  --data-binary @validations.csv`}</pre>
      </div>
      <div className="card">
        <div className="card-head">
          <h2>Загрузить файл валидаций</h2>
          <span className="hint">CSV или JSON до 10 МБ</span>
        </div>
        <div className="upload">
          <div className="row">
            <label className="btn file-pick">
              <Icon name="file" size={18} />
              Выбрать файл
              <input type="file" accept=".csv,.json,text/csv,application/json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
            <span className={'ellipsis' + (file ? '' : ' faint')} style={{ fontSize: 'var(--fs-sm)' }}>{file ? file.name : 'Файл не выбран'}</span>
          </div>
          <div className="row">
            <button type="button" className="btn btn-primary" disabled={!file || busy} onClick={send}>
              <Icon name="upload" size={18} />
              {busy ? 'Отправляем...' : 'Отправить'}
            </button>
          </div>
          {error && <Banner>{error}</Banner>}
          {result && (
            <div className="stack" style={{ gap: 8 }}>
              <div className="kv">
                <div><span>Принято</span><b>{fmt(result.accepted)}</b></div>
                <div><span>Отклонено</span><b>{fmt(result.rejected)}</b></div>
                <div><span>Посадок добавлено</span><b>{fmt(result.boardings)}</b></div>
              </div>
              {result.errors.length > 0 && (
                <ul className="errors">
                  {result.errors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
