import { useMemo, useState } from 'react'
import { factorEffect as effect, useApi, type FactorKey, type Factors, type ForecastResp } from '../api'
import { bandSeries, baseOption, EChart, lineSeries, tipHead, tipRow } from '../chart'
import { dateShort, fmt, fmt1, pct, periodLabel } from '../format'
import { useApp } from '../theme'
import { Busy, ErrorState, Legend, Loading, Popover, Range, RoutePicker, Segmented, Stat, useNarrow } from '../ui'
import { HORIZONS, type Horizon } from './ForecastPage'

const SLIDERS: { key: FactorKey; param: string; label: string; unit: string; step: number }[] = [
  { key: 'temp_delta', param: 'tempDelta', label: 'Температура относительно нормы', unit: '°C', step: 1 },
  { key: 'precip_mm', param: 'precipMm', label: 'Дождь, осадки за сутки', unit: 'мм', step: 1 },
  { key: 'snow_cm', param: 'snowCm', label: 'Снегопад', unit: 'см', step: 1 },
  { key: 'event_pct', param: 'eventPct', label: 'Событие или перекрытие', unit: '%', step: 5 },
  { key: 'season_pct', param: 'seasonPct', label: 'Сезонная поправка', unit: '%', step: 1 },
]

type Values = Record<FactorKey, number>
const ZERO: Values = { temp_delta: 0, precip_mm: 0, snow_cm: 0, event_pct: 0, season_pct: 0 }

// the API may return p10/p90 before or after the correction; value/p50 tells which, so scale by it
const band = (p?: ForecastResp['series'][number]) => {
  if (!p) return [null, null] as const
  const k = p.p50 > 0 ? p.value / p.p50 : 1
  return [p.p10 * k, p.p90 * k] as const
}

const signed = (v: number, unit: string) => (v > 0 ? '+' : v < 0 ? '-' : '') + fmt1(Math.abs(v)) + ' ' + unit

export default function ScenarioPage() {
  const factors = useApi<Factors>('/factors')
  if (factors.error) return <div className="page"><div className="card"><ErrorState message={factors.error} onRetry={factors.reload} height={360} /></div></div>
  if (!factors.data) return <Loading height={360} />
  return <Scenario f={factors.data} />
}

function Scenario({ f }: { f: Factors }) {
  const { palette } = useApp()
  const narrow = useNarrow()
  const [horizon, setHorizon] = useState<Horizon>('month')
  const [routes, setRoutes] = useState<number[]>([])
  const [v, setV] = useState<Values>(ZERO)

  const scope = { horizon, route: routes.join(',') }
  const corr = Object.fromEntries(SLIDERS.map((s) => [s.param, v[s.key]]))
  const base = useApi<ForecastResp>('/forecast', scope)
  const adj = useApi<ForecastResp>('/forecast', { ...scope, ...corr }, 150)
  const changed = SLIDERS.some((s) => v[s.key] !== 0)
  const preset = f.presets.find((p) => SLIDERS.every((s) => p[s.key] === v[s.key]))

  const option = useMemo(() => {
    const b = base.data
    const a = adj.data
    if (!b || !a) return null
    const o = baseOption(palette, narrow)
    const x = b.series.map((p) => p.t)
    const byT = new Map(a.series.map((p) => [p.t, p]))
    const val = x.map((t) => byT.get(t)?.value ?? null)
    return {
      ...o,
      xAxis: { ...(o.xAxis as object), data: x, axisLabel: { ...(o.xAxis as { axisLabel: object }).axisLabel, formatter: (t: string) => periodLabel(t, b.granularity, true) } },
      tooltip: {
        ...(o.tooltip as object),
        formatter: (ps: { dataIndex: number }[]) => {
          const i = ps[0]?.dataIndex ?? 0
          const p = byT.get(x[i])
          return (
            tipHead(periodLabel(x[i], b.granularity), palette.text3) +
            tipRow(palette.base, 'Базовый', fmt(b.series[i].p50)) +
            tipRow(palette.forecast, 'С поправками', fmt(p?.value)) +
            (p ? tipRow(palette.forecast, 'p10-p90', `${fmt(band(p)[0])} - ${fmt(band(p)[1])}`, 'band') : '')
          )
        },
      },
      series: [
        ...bandSeries('Интервал', x.map((t) => band(byT.get(t))[0]), x.map((t) => band(byT.get(t))[1]), palette.forecast),
        lineSeries('Базовый', b.series.map((p) => p.p50), palette.base, { lineStyle: { width: 2, color: palette.base, type: [5, 4] } }),
        lineSeries('С поправками', val, palette.forecast),
      ],
    }
  }, [base.data, adj.data, palette, narrow])

  const bt = base.data?.total.p50 ?? 0
  const at = adj.data?.total.value ?? 0
  const err = base.error || adj.error

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Сценарии</h1>
          <p>Поправки на погоду, события и сезон. Прогноз пересчитывается сразу, базовая линия остаётся для сравнения.</p>
        </div>
        <div className="toolbar">
          <Segmented<Horizon> label="Горизонт" value={horizon} options={HORIZONS} onChange={setHorizon} />
          <RoutePicker value={routes} onChange={setRoutes} />
        </div>
      </div>

      <div className="scen-layout">
        <div className="card">
          <div className="card-head">
            <h2>Поправки</h2>
            <button type="button" className="btn btn-ghost" disabled={!changed} onClick={() => setV(ZERO)}>
              Сбросить
            </button>
          </div>
          {f.presets.length > 0 && (
            <div className="presets" role="group" aria-label="Готовые сценарии" style={{ marginBottom: 8 }}>
              {f.presets.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  className="chip"
                  aria-pressed={preset?.id === p.id && changed}
                  onClick={() => setV(Object.fromEntries(SLIDERS.map((s) => [s.key, p[s.key] ?? 0])) as Values)}
                >
                  {p.title}
                </button>
              ))}
            </div>
          )}
          {SLIDERS.map((s) => {
            const [lo, hi] = f.limits[s.key] ?? [0, 0]
            const val = v[s.key]
            const e = effect(f, s.key, val)
            return (
              <div className="slider" key={s.key}>
                <div className="slider-top">
                  <span>{s.label}</span>
                  <output className={val === 0 ? 'zero' : ''}>{signed(val, s.unit)}</output>
                </div>
                <Range label={s.label} value={val} min={lo} max={hi} step={s.step} zero={lo < 0 ? 0 : lo} onChange={(x) => setV({ ...v, [s.key]: x })} />
                <div className="slider-lim">
                  <span>{fmt(lo)}</span>
                  <span className={e ? 'effect' : ''}>{e == null || val === 0 ? '' : `прогноз ${pct(e * 100)}`}</span>
                  <span>{fmt(hi)}</span>
                </div>
              </div>
            )
          })}
          <p className="note" style={{ marginTop: 8 }}>
            Итог = базовый прогноз × погода × (1 + событие) × (1 + сезон). Поправка одна на весь период и на все часы.
          </p>
          <div style={{ marginTop: 12 }}>
            <Popover label="Как считается погода" title="Погодный множитель">
              <div className="stack" style={{ gap: 8 }}>
                <div className="formula">exp(холод × похолодание + жара × потепление + дождь × ln(1 + мм) + снег × ln(1 + см))</div>
                <dl className="dl">
                  <dt>холод</dt><dd className="num">{f.weather.cold_coef ?? '-'} на 1 °C</dd>
                  <dt>жара</dt><dd className="num">{f.weather.heat_coef ?? '-'} на 1 °C</dd>
                  <dt>дождь</dt><dd className="num">{f.weather.precip_coef ?? '-'}</dd>
                  <dt>снег</dt><dd className="num">{f.weather.snow_coef ?? '-'}</dd>
                </dl>
                {f.note && <p className="note">{f.note}</p>}
              </div>
            </Popover>
          </div>
        </div>

        <div className="stack">
          {err ? (
            <div className="card"><ErrorState message={err} onRetry={() => { base.reload(); adj.reload() }} height={360} /></div>
          ) : !option || !base.data || !adj.data ? (
            <Loading height={420} />
          ) : (
            <Busy busy={adj.loading}>
              <div className="stack">
                <div className="stats">
                  <Stat label="Базовый прогноз" value={fmt(bt)} sub={`${dateShort(base.data.from)} - ${dateShort(base.data.to)}`} />
                  <Stat label="С поправками" value={fmt(at)} sub="посадок за период" />
                  <Stat label="Изменение" value={bt ? pct(((at - bt) / bt) * 100) : '-'} sub={`${at >= bt ? '+' : '-'}${fmt(Math.abs(at - bt))} посадок`} signal={changed} />
                  <Stat label="Множитель" value={'×' + adj.data.multiplier.toLocaleString('ru-RU', { maximumFractionDigits: 3 })} sub="к медиане и интервалу" />
                </div>
                <div className="card">
                  <div className="card-head">
                    <h2>Базовый и скорректированный прогноз</h2>
                    <Legend
                      items={[
                        { label: 'Базовый', color: palette.base },
                        { label: 'С поправками', color: palette.forecast },
                        { label: 'Интервал p10-p90', color: palette.forecast, kind: 'band' },
                      ]}
                    />
                  </div>
                  <EChart option={option} height={narrow ? 260 : 360} />
                </div>
                <div className="card">
                  <div className="card-head">
                    <h2>Из чего складывается поправка</h2>
                    <span className="hint">каждый фактор отдельно</span>
                  </div>
                  <div className="table-wrap">
                    <table className="tbl">
                      <tbody>
                        {SLIDERS.map((s) => {
                          const e = v[s.key] === 0 ? null : effect(f, s.key, v[s.key])
                          return (
                            <tr key={s.key}>
                              <td>{s.label}</td>
                              <td className="faint">{v[s.key] === 0 ? 'без поправки' : signed(v[s.key], s.unit)}</td>
                              <td><b>{e == null ? '-' : pct(e * 100)}</b></td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </Busy>
          )}
        </div>
      </div>
    </div>
  )
}
