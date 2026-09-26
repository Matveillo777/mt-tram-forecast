import { Fragment, useMemo, useState } from 'react'
import { useApi, type EffectKey, type FactorKey, type Factors, type ForecastResp } from '../api'
import { bandSeries, baseOption, EChart, lineSeries, tipHead, tipRow } from '../chart'
import { dateShort, fmt, fmt1, pct, periodLabel } from '../format'
import { useApp } from '../theme'
import { Busy, ErrorState, Legend, Loading, Popover, Range, RoutePicker, Segmented, Stat, useNarrow } from '../ui'
import { HORIZONS, type Horizon } from './ForecastPage'

// delta: the value shifts the weather of each day; otherwise it replaces the daytime amount from the weather forecast
type Slider = { key: FactorKey; param: string; effect: EffectKey; label: string; unit: string; step: number; delta: boolean }

const SLIDERS: Slider[] = [
  { key: 'temp_delta', param: 'tempDelta', effect: 'temp', label: 'Сдвиг температуры', unit: '°C', step: 1, delta: true },
  { key: 'precip_mm', param: 'precipMm', effect: 'precip', label: 'Дождь днём, 7-21 ч', unit: 'мм', step: 1, delta: false },
  { key: 'snow_cm', param: 'snowCm', effect: 'snow', label: 'Снег днём, 7-21 ч', unit: 'см', step: 0.5, delta: false },
  { key: 'event_pct', param: 'eventPct', effect: 'event', label: 'Событие или перекрытие', unit: '%', step: 5, delta: true },
  { key: 'season_pct', param: 'seasonPct', effect: 'season', label: 'Сезонная поправка', unit: '%', step: 1, delta: true },
]

type Values = Record<FactorKey, number>
const ZERO: Values = { temp_delta: 0, precip_mm: 0, snow_cm: 0, event_pct: 0, season_pct: 0 }

const signed = (v: number, unit: string) => (v > 0 ? '+' : v < 0 ? '-' : '') + fmt1(Math.abs(v)) + ' ' + unit
const shown = (s: Slider, v: number) => (s.delta ? signed(v, s.unit) : v === 0 ? 'по прогнозу погоды' : fmt1(v) + ' ' + s.unit)
const noEffect = (e: number) => Math.abs(e - 1) < 0.001
const coef = (x: number) => (x === 0 ? '0' : x.toLocaleString('ru-RU', { maximumFractionDigits: 5 }))

/** Why a set factor changes nothing: the model reacts to weather only past its thresholds. */
function whyNoEffect(f: Factors, key: FactorKey) {
  const w = f.weather
  switch (key) {
    case 'precip_mm':
      return `в будни при температуре ниже ${w.rain_warm_min_t} °C дождь на поездки почти не влияет`
    case 'temp_delta':
      return (
        `спрос меняется только в жару выше ${w.heat_above_t} °C и в дождь по будням от ${w.rain_warm_min_t} °C` +
        (w.coef.cold === 0 ? ', а мороз на поездки почти не влиял' : `, а также в мороз ниже ${w.cold_below_t} °C`)
      )
    case 'snow_cm':
      return w.coef.snow === 0 ? 'снег на поездки почти не влиял' : 'в прогнозе погоды на эти дни уже столько снега'
    default:
      return ''
  }
}

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
  // effect of each factor alone over the selected period, as the backend computed it day by day
  const effectOf = (s: Slider) => (v[s.key] === 0 ? null : adj.data?.factor_effects?.[s.effect] ?? null)

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
            (p ? tipRow(palette.forecast, 'p10-p90', `${fmt(p.p10)} - ${fmt(p.p90)}`, 'band') : '')
          )
        },
      },
      series: [
        ...bandSeries('Интервал', x.map((t) => byT.get(t)?.p10 ?? null), x.map((t) => byT.get(t)?.p90 ?? null), palette.forecast),
        lineSeries('Базовый', b.series.map((p) => p.p50), palette.base, { lineStyle: { width: 2, color: palette.base, type: [5, 4] } }),
        lineSeries('С поправками', val, palette.forecast),
      ],
    }
  }, [base.data, adj.data, palette, narrow])

  const bt = base.data?.total.p50 ?? 0
  const at = adj.data?.total.value ?? 0
  const err = base.error || adj.error
  const w = f.weather

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
            const e = effectOf(s)
            return (
              <div className="slider" key={s.key}>
                <div className="slider-top">
                  <span>{s.label}</span>
                  <output className={val === 0 ? 'zero' : ''}>{shown(s, val)}</output>
                </div>
                <Range label={s.label} value={val} min={lo} max={hi} step={s.step} zero={lo < 0 ? 0 : lo} onChange={(x) => setV({ ...v, [s.key]: x })} />
                <div className="slider-lim">
                  <span>{fmt(lo)}</span>
                  <span className={e == null ? '' : 'effect'}>{e == null ? '' : noEffect(e) ? 'в этот период не влияет' : `прогноз ${pct((e - 1) * 100)}`}</span>
                  <span>{fmt(hi)}</span>
                </div>
              </div>
            )
          })}
          {f.note && <p className="note" style={{ marginTop: 8 }}>{f.note}</p>}
          <div style={{ marginTop: 12 }}>
            <Popover label="Как считается" title="Поправка сценария">
              <div className="stack" style={{ gap: 8 }}>
                {f.formula && <div className="prose"><p>{f.formula}</p></div>}
                <dl className="dl">
                  <dt>дождь в будни от {w.rain_warm_min_t} °C</dt><dd className="num">{coef(w.coef.rain_warm)}</dd>
                  <dt>дождь в выходные</dt><dd className="num">{coef(w.coef.rain_we)}</dd>
                  <dt>снег</dt><dd className="num">{coef(w.coef.snow)}</dd>
                  <dt>жара выше {w.heat_above_t} °C</dt><dd className="num">{coef(w.coef.heat)}</dd>
                  <dt>мороз ниже {w.cold_below_t} °C</dt><dd className="num">{coef(w.coef.cold)}</dd>
                </dl>
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
                  <Stat label="Изменение" value={bt ? pct(((at - bt) / bt) * 100) : '-'} sub={`${at >= bt ? '+' : '-'}${fmt(Math.abs(at - bt))} посадок`} signal={at !== bt} />
                  <Stat label="Множитель" value={'×' + adj.data.multiplier.toLocaleString('ru-RU', { maximumFractionDigits: 3 })} sub="в среднем за период" />
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
                    <span className="hint">каждый фактор отдельно, за период</span>
                  </div>
                  <div className="table-wrap">
                    <table className="tbl">
                      <tbody>
                        {SLIDERS.map((s) => {
                          const e = effectOf(s)
                          const why = e != null && noEffect(e) ? whyNoEffect(f, s.key) : null
                          return (
                            <Fragment key={s.key}>
                              <tr className={why != null ? 'has-note' : ''}>
                                <td className="wrap">{s.label}</td>
                                <td className="faint">{v[s.key] === 0 ? 'без поправки' : shown(s, v[s.key])}</td>
                                <td><b>{e == null ? '-' : pct((e - 1) * 100)}</b></td>
                              </tr>
                              {why != null && (
                                <tr>
                                  <td colSpan={3} className="row-note">в выбранный период не влияет{why && ': ' + why}</td>
                                </tr>
                              )}
                            </Fragment>
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
