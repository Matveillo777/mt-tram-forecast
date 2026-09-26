import { useMemo, useState } from 'react'
import { download, errorText, useApi, type ForecastResp, type HistoryResp, type Meta, type RouteFull } from '../api'
import { bandSeries, baseOption, EChart, lineSeries, tipHead, tipRow } from '../chart'
import { addDays, compactRange, dateMid, dateShort, diffDays, fmt, hh, pct, periodLabel } from '../format'
import { Icon } from '../icons'
import { useApp } from '../theme'
import { Banner, Busy, Empty, ErrorState, Legend, Loading, Popover, RoutePicker, Segmented, Stat, useNarrow } from '../ui'

export type Horizon = 'day' | 'month' | 'year'
export type Gran = 'hour' | 'day' | 'month'

export const HORIZONS: { value: Horizon; label: string }[] = [
  { value: 'day', label: 'День' },
  { value: 'month', label: 'Месяц' },
  { value: 'year', label: 'Год' },
]
const GRANS: { value: Gran; label: string }[] = [
  { value: 'hour', label: 'Часы' },
  { value: 'day', label: 'Дни' },
  { value: 'month', label: 'Месяцы' },
]
const DEFAULT_GRAN: Record<Horizon, Gran> = { day: 'hour', month: 'day', year: 'month' }
const HOUR_PRESETS: { label: string; v: [number, number] }[] = [
  { label: 'Круглые сутки', v: [0, 23] },
  { label: 'Утренний пик', v: [7, 9] },
  { label: 'Дневные часы', v: [10, 16] },
  { label: 'Вечерний пик', v: [17, 19] },
]
const TABLE_LIMIT = 500

/** Same default interval as the API: today plus 1, 30 or 365 days, clipped to the forecast range. */
export function horizonPeriod(meta: Meta, h: Horizon) {
  const days = { day: 1, month: 30, year: 365 }[h]
  const to = addDays(meta.today, days - 1)
  return { from: meta.today, to: to > meta.forecast_to ? meta.forecast_to : to }
}

export const hoursLabel = ([a, b]: [number, number]) => (a === 0 && b === 23 ? 'Круглые сутки' : `${hh(a)}-${b === 23 ? '24:00' : hh(b + 1)}`)

export default function ForecastPage() {
  const { meta, palette } = useApp()
  const narrow = useNarrow()
  const [horizon, setHorizon] = useState<Horizon>('day')
  const [routes, setRoutes] = useState<number[]>([])
  const [stop, setStop] = useState('')
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null)
  const [hours, setHours] = useState<[number, number]>([0, 23])
  const [gran, setGran] = useState<Gran>('hour')
  const [exporting, setExporting] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)

  const { from, to } = custom ?? horizonPeriod(meta, horizon)
  const invalid = from > to
  const single = routes.length === 1 ? routes[0] : null
  const stopsReq = useApi<RouteFull>(single != null ? `/routes/${single}` : null)
  const stops = single != null ? stopsReq.data?.stops ?? [] : []

  const params = {
    horizon,
    from,
    to,
    hourFrom: hours[0],
    hourTo: hours[1],
    route: routes.join(','),
    stop: single != null ? stop : '',
    granularity: gran,
  }
  const fc = useApi<ForecastResp>(invalid ? null : '/forecast', params, 120)

  // fact for the same number of days right before the period, when it falls into history
  const len = diffDays(from, to) + 1
  const ctxTo = addDays(from, -1)
  const hasCtx = !invalid && ctxTo >= meta.history_from && ctxTo <= meta.history_to
  const ctxFrom = hasCtx ? (addDays(from, -len) < meta.history_from ? meta.history_from : addDays(from, -len)) : ''
  const hist = useApi<HistoryResp>(hasCtx ? '/history' : null, { ...params, horizon: '', from: ctxFrom, to: ctxTo }, 120)
  const ctx = hasCtx ? hist.data : undefined
  const ctxFull = hasCtx && ctxFrom === addDays(from, -len)

  const setH = (h: Horizon) => {
    setHorizon(h)
    setCustom(null)
    setGran(DEFAULT_GRAN[h])
  }
  const setR = (r: number[]) => {
    setRoutes(r)
    setStop('')
  }

  const doExport = async (format: 'csv' | 'xlsx') => {
    setExporting(format)
    setExportError(null)
    try {
      await download('/export', { ...params, format }, `forecast.${format}`)
    } catch (e) {
      setExportError(errorText(e))
    } finally {
      setExporting(null)
    }
  }

  const data = fc.data
  const peak = useMemo(() => {
    if (!data?.series.length) return null
    return data.series.reduce((a, b) => (b.p50 > a.p50 ? b : a))
  }, [data])

  const option = useMemo(() => {
    if (!data) return null
    const o = baseOption(palette, narrow)
    const hx = ctx?.series ?? []
    const n = hx.length
    const g = data.granularity
    const x = [...hx.map((p) => p.t), ...data.series.map((p) => p.t)]
    const pad = <T,>(k: number) => new Array<T | null>(k).fill(null)
    const fact = [...hx.map((p) => p.actual), ...pad<number>(data.series.length)]
    const p50 = [...pad<number>(n), ...data.series.map((p) => p.p50)]
    const lo = [...pad<number>(n), ...data.series.map((p) => p.p10)]
    const hi = [...pad<number>(n), ...data.series.map((p) => p.p90)]
    const multiDay = g === 'hour' && x.length > 24
    const series: unknown[] = [...bandSeries('Интервал p10-p90', lo, hi, palette.forecast)]
    if (n) series.push(lineSeries('Факт', fact, palette.fact, { sampling: 'lttb' }))
    series.push(
      lineSeries('Прогноз', p50, palette.forecast, {
        sampling: 'lttb',
        showSymbol: x.length <= 2,
        ...(n
          ? {
              markLine: {
                silent: true,
                symbol: 'none',
                lineStyle: { color: palette.lineStrong, type: [4, 4], width: 1 },
                label: { formatter: 'прогноз', position: 'insideEndTop', color: palette.text3, fontSize: 12 },
                data: [{ xAxis: data.series[0]?.t }],
              },
            }
          : {}),
      }),
    )
    return {
      ...o,
      xAxis: {
        ...(o.xAxis as object),
        data: x,
        axisLabel: {
          ...(o.xAxis as { axisLabel: object }).axisLabel,
          formatter: (t: string) => (multiDay ? `${dateShort(t)} ${t.slice(11, 13)}ч` : periodLabel(t, g, true)),
        },
      },
      tooltip: {
        ...(o.tooltip as object),
        formatter: (ps: { dataIndex: number }[]) => {
          const i = ps[0]?.dataIndex ?? 0
          if (i < n) return tipHead(periodLabel(x[i], g), palette.text3) + tipRow(palette.fact, 'Факт', fmt(fact[i]))
          const p = data.series[i - n]
          return (
            tipHead(periodLabel(p.t, g), palette.text3) +
            tipRow(palette.forecast, 'Прогноз', fmt(p.p50)) +
            tipRow(palette.forecast, 'p10-p90', `${fmt(p.p10)} - ${fmt(p.p90)}`, 'band')
          )
        },
      },
      series,
    }
  }, [data, ctx, palette, narrow])

  const prevTotal = ctx?.total.actual ?? 0

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Прогноз пассажиропотока</h1>
          <p>Посадки по маршрутам и остановкам на день, месяц или год вперёд. Медиана и интервал, в который факт попадает в 80% случаев.</p>
        </div>
        <div className="toolbar">
          <button type="button" className="btn" disabled={invalid || exporting !== null} onClick={() => doExport('csv')}>
            <Icon name="download" size={18} />
            {exporting === 'csv' ? 'Готовим...' : 'CSV'}
          </button>
          <button type="button" className="btn" disabled={invalid || exporting !== null} onClick={() => doExport('xlsx')}>
            <Icon name="download" size={18} />
            {exporting === 'xlsx' ? 'Готовим...' : 'XLSX'}
          </button>
        </div>
      </div>

      <div className="toolbar filters">
        <Segmented<Horizon> label="Горизонт" value={custom ? ('' as Horizon) : horizon} options={HORIZONS} onChange={setH} />
        <RoutePicker value={routes} onChange={setR} />
        <select
          className="select"
          aria-label="Остановка"
          value={stop}
          disabled={single == null || stops.length === 0}
          title={single == null ? 'Остановку можно выбрать, когда выбран один маршрут' : undefined}
          onChange={(e) => setStop(e.target.value)}
        >
          <option value="">{single == null ? 'Остановка: выберите один маршрут' : stops.length ? 'Все остановки' : 'Нет данных по остановкам'}</option>
          {stops.map((s) => (
            <option key={s.stop_id} value={s.stop_id}>
              {s.seq}. {s.name}
            </option>
          ))}
        </select>
        <Popover label={from === to ? dateMid(from) : `${dateShort(from)} - ${dateMid(to)}`} icon="calendar" title="Период прогноза">
          {(close) => (
            <PeriodForm
              meta={meta}
              from={from}
              to={to}
              onChange={(f, t) => setCustom({ from: f, to: t })}
              onReset={() => {
                setCustom(null)
                close()
              }}
            />
          )}
        </Popover>
        <Popover label={hoursLabel(hours)} icon="clock" title="Часы суток">
          {(close) => <HoursForm value={hours} onChange={setHours} onDone={close} />}
        </Popover>
      </div>

      {exportError && <Banner>Выгрузка не удалась: {exportError}</Banner>}
      {invalid && <Banner>Дата начала позже даты окончания. Исправьте период.</Banner>}

      {fc.error ? (
        <div className="card">
          <ErrorState message={fc.error} onRetry={fc.reload} height={360} />
        </div>
      ) : !data || !option ? (
        invalid ? null : <Loading height={420} />
      ) : (
        <Busy busy={fc.loading || hist.loading}>
          <div className="stack">
            <div className="stats">
              <Stat label="Прогноз за период" value={fmt(data.total.p50)} sub={`посадок, ${dateShort(data.from)} - ${dateShort(data.to)}`} />
              <Stat label="Интервал p10-p90" value={compactRange(data.total.p10, data.total.p90)} sub="80% вероятных исходов" />
              <Stat label="Пик" value={peak ? fmt(peak.p50) : '-'} sub={peak ? periodLabel(peak.t, data.granularity) : ''} />
              {ctxFull && prevTotal > 0 ? (
                <Stat label="К предыдущему периоду" value={pct(((data.total.p50 - prevTotal) / prevTotal) * 100)} sub={`факт: ${fmt(prevTotal)}`} />
              ) : (
                <Stat label="В среднем за сутки" value={fmt(data.total.p50 / len)} sub={`${len} дн. в периоде`} />
              )}
            </div>

            <div className="card">
              <div className="card-head">
                <h2>Посадки по {gran === 'hour' ? 'часам' : gran === 'day' ? 'дням' : 'месяцам'}</h2>
                <Segmented<Gran> label="Шаг" value={gran} options={GRANS} onChange={setGran} />
              </div>
              {data.series.length === 0 ? (
                <Empty text="За выбранный период и часы прогноза нет." height={300} />
              ) : (
                <>
                  <EChart option={option} height={narrow ? 260 : 340} />
                  <Legend
                    items={[
                      ...(ctx?.series.length ? [{ label: 'Факт до начала периода', color: palette.fact }] : []),
                      { label: 'Прогноз, медиана', color: palette.forecast },
                      { label: 'Интервал p10-p90', color: palette.forecast, kind: 'band' as const },
                    ]}
                  />
                </>
              )}
            </div>

            <div className="card">
              <div className="card-head">
                <h2>Таблица</h2>
                <span className="hint">
                  {data.series.length} {data.series.length === 1 ? 'строка' : 'строк'}
                  {data.stop ? `, остановка ${stops.find((s) => s.stop_id === data.stop)?.name ?? data.stop}` : ''}
                </span>
              </div>
              <ForecastTable data={data} />
            </div>
          </div>
        </Busy>
      )}
    </div>
  )
}

function ForecastTable({ data }: { data: ForecastResp }) {
  const rows = data.series.slice(0, TABLE_LIMIT)
  const max = Math.max(1, ...rows.map((r) => r.p90))
  return (
    <>
      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Период</th>
              <th>p10</th>
              <th>Медиана</th>
              <th>p90</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.t}>
                <td>{periodLabel(r.t, data.granularity)}</td>
                <td className="faint">{fmt(r.p10)}</td>
                <td>
                  <div className="bar-cell">
                    <b>{fmt(r.p50)}</b>
                    <span className="track"><span className="fill" style={{ width: (r.p50 / max) * 100 + '%' }} /></span>
                  </div>
                </td>
                <td className="faint">{fmt(r.p90)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.series.length > TABLE_LIMIT && (
        <p className="table-note">Показаны первые {TABLE_LIMIT} строк. Полная таблица есть в выгрузке CSV и XLSX.</p>
      )}
    </>
  )
}

export function PeriodForm({ meta, from, to, onChange, onReset }: {
  meta: Meta
  from: string
  to: string
  onChange: (from: string, to: string) => void
  onReset: () => void
}) {
  return (
    <>
      <div className="field-row">
        <label className="field">
          <span>С</span>
          <input type="date" className="input" value={from} min={meta.forecast_from} max={meta.forecast_to} onChange={(e) => e.target.value && onChange(e.target.value, to)} />
        </label>
        <label className="field">
          <span>По</span>
          <input type="date" className="input" value={to} min={meta.forecast_from} max={meta.forecast_to} onChange={(e) => e.target.value && onChange(from, e.target.value)} />
        </label>
      </div>
      <p className="note" style={{ marginTop: 8 }}>
        Прогноз доступен с {dateMid(meta.forecast_from)} по {dateMid(meta.forecast_to)}.
      </p>
      <div className="pop-foot">
        <button type="button" className="btn btn-ghost" onClick={onReset}>
          По горизонту
        </button>
      </div>
    </>
  )
}

export function HoursForm({ value, onChange, onDone }: { value: [number, number]; onChange: (v: [number, number]) => void; onDone: () => void }) {
  const opts = Array.from({ length: 24 }, (_, h) => h)
  return (
    <>
      <div className="presets" style={{ marginBottom: 12 }}>
        {HOUR_PRESETS.map((p) => (
          <button
            type="button"
            key={p.label}
            className="chip"
            aria-pressed={p.v[0] === value[0] && p.v[1] === value[1]}
            onClick={() => {
              onChange(p.v)
              onDone()
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="field-row">
        <label className="field">
          <span>С начала часа</span>
          <select className="select" value={value[0]} onChange={(e) => onChange([Number(e.target.value), Math.max(Number(e.target.value), value[1])])}>
            {opts.map((h) => <option key={h} value={h}>{hh(h)}</option>)}
          </select>
        </label>
        <label className="field">
          <span>По конец часа</span>
          <select className="select" value={value[1]} onChange={(e) => onChange([Math.min(value[0], Number(e.target.value)), Number(e.target.value)])}>
            {opts.map((h) => <option key={h} value={h}>{hh(h)}</option>)}
          </select>
        </label>
      </div>
    </>
  )
}
