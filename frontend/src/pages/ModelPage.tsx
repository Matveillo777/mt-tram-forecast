import { useMemo, type CSSProperties, type ReactNode } from 'react'
import { useApi, type CalendarRow, type EventRow, type ModelInfo } from '../api'
import { baseOption, EChart, tipHead, tipRow } from '../chart'
import { addDays, dateLong, dateMid, dateShort, fmt, pct } from '../format'
import { Icon } from '../icons'
import { useApp } from '../theme'
import { Empty, ErrorState, Loading, RouteDot, Stat, useNarrow } from '../ui'

const score = (v: number) => v.toLocaleString('ru-RU', { minimumFractionDigits: 3, maximumFractionDigits: 3 })
const ratio = (v: number) => '×' + v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const DAYS: Record<string, string> = { all: 'каждый день', weekend: 'по выходным', workday: 'по будням' }
const KNOWN = new Set(['model', 'backtests', 'by_route', 'external_effects', 'intervals'])
const TITLES: Record<string, string> = {
  applicability: 'Область применимости',
  domain: 'Область определения',
  adaptation: 'Область адаптации',
  limitations: 'Ограничения',
  data_sources: 'Источники данных',
  sources: 'Источники данных',
  pipeline: 'Конвейер данных',
  notes: 'Примечания',
}

// Model features: what the code means and how to read its coefficient.
// The coefficient multiplies log boardings, so the effect of x units is exp(coef * x) - 1.
const FEATURES: Record<string, { label: string; example: string; x: number }> = {
  hol: { label: 'Праздник в будний день', example: 'в такой день', x: 1 },
  hol_we: { label: 'Праздник в выходной', example: 'в такой день', x: 1 },
  pre: { label: 'Предпраздничный день', example: 'в такой день', x: 1 },
  school: { label: 'Школьные каникулы, будни', example: 'в такой день', x: 1 },
  rain_warm: { label: 'Дождь в тёплый будний день', example: '10 мм за день', x: Math.log1p(10) },
  rain_we: { label: 'Дождь в выходной', example: '10 мм за день', x: Math.log1p(10) },
  snow: { label: 'Снегопад', example: '10 см за день', x: Math.log1p(10) },
  heat: { label: 'Жара выше +20 °C', example: 'при +30 °C', x: 10 },
  cold: { label: 'Мороз ниже -5 °C', example: 'при -15 °C', x: 10 },
}
const featureLabel = (f: string) => FEATURES[f]?.label ?? f

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
const MONTHS_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']

function specialDay(key: string) {
  if (key === 'work_sat') return 'Рабочая суббота'
  const m = /^(\d{2})-(\d{2})$/.exec(key)
  return m ? `${Number(m[2])} ${MONTHS_GEN[Number(m[1]) - 1]}` : key
}

interface ModelExtra {
  coefficients?: Record<string, number>
  month_factor?: Record<string, number>
  special_days?: Record<string, number>
  trained_until?: string
}

function Ext({ href, children }: { href: string; children: ReactNode }) {
  if (!href) return <>{children}</>
  return (
    <a className="link ext" href={href} target="_blank" rel="noreferrer">
      {children}
      <Icon name="external" size={14} />
    </a>
  )
}

export default function ModelPage() {
  const { meta } = useApp()
  const model = useApi<ModelInfo>('/model')
  const events = useApi<EventRow[]>('/events')
  const cal = useApi<CalendarRow[]>('/calendar', { from: meta.forecast_from, to: meta.forecast_to })

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Модель и данные</h1>
          <p>Точность на проверке по истории, вклад внешних источников и календарь, который учитывает прогноз. Метрика WAPE-score = 1 - WAPE, чем ближе к 1, тем лучше.</p>
        </div>
      </div>

      {model.error ? (
        <div className="card"><ErrorState message={model.error} onRetry={model.reload} height={300} /></div>
      ) : !model.data ? (
        <Loading height={300} />
      ) : (
        <ModelBlocks m={model.data} />
      )}

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h2>События на маршрутах</h2>
            <span className="hint">ремонты и перекрытия, учтены в модели</span>
          </div>
          {events.error ? (
            <ErrorState message={events.error} onRetry={events.reload} />
          ) : !events.data ? (
            <Loading />
          ) : events.data.length === 0 ? (
            <Empty text="Событий нет." />
          ) : (
            <EventList rows={events.data} />
          )}
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Календарь периода прогноза</h2>
            <span className="hint">{dateMid(meta.forecast_from)} - {dateMid(meta.forecast_to)}</span>
          </div>
          {cal.error ? <ErrorState message={cal.error} onRetry={cal.reload} /> : !cal.data ? <Loading /> : <CalendarList rows={cal.data} />}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>О данных</h2>
        </div>
        <div className="grid-2">
          <dl className="dl">
            <dt>Факт</dt>
            <dd>{dateLong(meta.history_from)} - {dateLong(meta.history_to)}, по часам</dd>
            <dt>Прогноз</dt>
            <dd>{dateLong(meta.forecast_from)} - {dateLong(meta.forecast_to)}, по часам</dd>
            <dt>Дата сервиса</dt>
            <dd>{dateLong(meta.today)}</dd>
            <dt>Маршруты</dt>
            <dd>{meta.routes.join(', ')}</dd>
          </dl>
          <div className="prose">
            <p>
              Посадка - одна успешная валидация билета (<code>validation_result = 1</code>). Маршрут берётся из поля <code>ngpt_route</code>, время из{' '}
              <code>tran_date_time</code>.
            </p>
            <p>
              Модель прогнозирует посадки на маршруте за час. Посадки на остановке - оценка: посадки маршрута за час делятся между остановками по их долям. Схемы маршрутов и
              координаты остановок взяты из справочников.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

function ModelBlocks({ m }: { m: ModelInfo }) {
  const { routeName } = useApp()
  const extra = m.model as ModelInfo['model'] & ModelExtra
  const intervals = m.intervals as { p10_ratio?: number; p90_ratio?: number; note?: string } | undefined
  const extras = Object.entries(m).filter(([k, v]) => !KNOWN.has(k) && v != null && (TITLES[k] || (typeof v === 'object' && 'title' in (v as object))))
  const backtests = [...m.backtests].sort((a, b) => a.origin.localeCompare(b.origin))
  const last = backtests[backtests.length - 1]
  const mean = backtests.length ? backtests.reduce((a, b) => a + b.wape_score, 0) / backtests.length : null
  const routeScores = m.by_route.map((r) => r.wape_score)
  const coefs = Object.entries(extra.coefficients ?? {})

  return (
    <>
      <div className="stats">
        <Stat label="Точность на истории" value={mean == null ? '-' : score(mean)} sub={`WAPE-score, среднее по ${backtests.length} окнам`} />
        <Stat
          label="Последнее окно"
          value={last ? score(last.wape_score) : '-'}
          sub={last ? `${dateShort(addDays(last.origin, 1))} - ${dateMid(addDays(last.origin, last.horizon_days))}` : 'нет проверок'}
        />
        <Stat
          label="По маршрутам"
          value={routeScores.length ? `${score(Math.min(...routeScores))} - ${score(Math.max(...routeScores))}` : '-'}
          sub="худший и лучший маршрут"
        />
        {intervals?.p10_ratio != null && intervals.p90_ratio != null && (
          <Stat label="Интервал p10-p90" value={`${ratio(intervals.p10_ratio)} - ${ratio(intervals.p90_ratio)}`} sub="к медиане, по окнам проверки" />
        )}
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h2>{m.model.name || 'Модель'}</h2>
            {extra.trained_until && <span className="hint">обучена по {dateMid(extra.trained_until)}</span>}
          </div>
          <div className="stack" style={{ gap: 12 }}>
            {m.model.description && <p className="prose">{m.model.description}</p>}
            {m.model.features.length > 0 && (
              <div>
                <p className="note" style={{ marginBottom: 6 }}>Признаки дня</p>
                <div className="feature-list">
                  {m.model.features.map((f) => <span key={f}>{featureLabel(f)}</span>)}
                </div>
              </div>
            )}
            {intervals?.note && <p className="note">Интервал: {intervals.note}.</p>}
            {!m.model.description && !m.model.features.length && <Empty text="Описание модели появится после обучения." height={120} />}
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Проверка на истории</h2>
            <span className="hint">модель обучена до начала окна</span>
          </div>
          {backtests.length === 0 ? (
            <Empty text="Проверок ещё нет." height={160} />
          ) : (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Окно прогноза</th>
                    <th>Дней</th>
                    <th>WAPE-score</th>
                  </tr>
                </thead>
                <tbody>
                  {backtests.map((b) => (
                    <tr key={b.origin + b.horizon_days}>
                      <td>{dateShort(addDays(b.origin, 1))} - {dateMid(addDays(b.origin, b.horizon_days))}</td>
                      <td>{b.horizon_days}</td>
                      <td><ScoreBar v={b.wape_score} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {(coefs.length > 0 || extra.month_factor) && (
        <div className="grid-2">
          <div className="card">
            <div className="card-head">
              <h2>Коэффициенты модели</h2>
              <span className="hint">влияние на посадки за день</span>
            </div>
            {coefs.length === 0 ? (
              <Empty text="Коэффициенты не опубликованы." height={160} />
            ) : (
              <>
                <div className="table-wrap">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Признак</th>
                        <th className="opt">Коэф.</th>
                        <th className="l">Пример</th>
                        <th>Эффект</th>
                      </tr>
                    </thead>
                    <tbody>
                      {coefs.map(([k, c]) => {
                        const f = FEATURES[k]
                        return (
                          <tr key={k}>
                            <td className="wrap">{featureLabel(k)}</td>
                            <td className="faint opt">{c.toLocaleString('ru-RU', { maximumFractionDigits: 4 })}</td>
                            <td className="l faint">{f?.example ?? ''}</td>
                            <td><b>{f ? pct((Math.exp(c * f.x) - 1) * 100) : '-'}</b></td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="table-note">Коэффициенты погоды используются и в сценариях: поправка на температуру, дождь и снег считается по ним.</p>
              </>
            )}
          </div>
          <div className="card">
            <div className="card-head">
              <h2>Сезонность</h2>
              <span className="hint">множитель месяца к уровню дня</span>
            </div>
            {extra.month_factor ? <Seasonality months={extra.month_factor} special={extra.special_days} /> : <Empty text="Сезонные множители не опубликованы." height={160} />}
          </div>
        </div>
      )}

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h2>Точность по маршрутам</h2>
            <span className="hint">WAPE-score, все окна проверки</span>
          </div>
          {m.by_route.length === 0 ? (
            <Empty text="Оценка по маршрутам ещё не посчитана." height={160} />
          ) : (
            <div className="table-wrap">
              <table className="tbl">
                <tbody>
                  {m.by_route.map((r) => (
                    <tr key={r.route}>
                      <td className="shrink">
                        <span className="row" style={{ flexWrap: 'nowrap' }}>
                          <RouteDot route={r.route} />
                          <b>{r.route}</b>
                          <span className="faint ellipsis">{routeName(r.route)}</span>
                        </span>
                      </td>
                      <td><ScoreBar v={r.wape_score} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Внешние источники</h2>
            <span className="hint">точность без источника и с ним</span>
          </div>
          {m.external_effects.length === 0 ? (
            <Empty text="Замеры вклада источников ещё не добавлены." height={140} />
          ) : (
            <div className="sources">
              {m.external_effects.map((e) => (
                <div className="source" key={e.source + e.metric}>
                  <div className="source-top">
                    <Ext href={e.url}>{e.source}</Ext>
                    <b className="num">{e.delta > 0 ? '+' : ''}{score(e.delta)}</b>
                  </div>
                  <div className="source-sub num">
                    {score(e.without)} без источника, {score(e.with)} с ним · {e.metric}
                  </div>
                  {e.note && <div className="source-sub">{e.note}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {extras.map(([k, v]) => (
        <div className="card" key={k}>
          <div className="card-head">
            <h2>{(v as { title?: string }).title ?? TITLES[k]}</h2>
          </div>
          <Free value={v} />
        </div>
      ))}
    </>
  )
}

function ScoreBar({ v }: { v: number }) {
  return (
    <div className="bar-cell">
      <span className="num">{score(v)}</span>
      <span className="track"><span className="fill" style={{ width: Math.max(0, Math.min(1, v)) * 100 + '%' } as CSSProperties} /></span>
    </div>
  )
}

function Seasonality({ months, special }: { months: Record<string, number>; special?: Record<string, number> }) {
  const { palette } = useApp()
  const narrow = useNarrow()
  const option = useMemo(() => {
    const values = MONTHS.map((_, i) => months[String(i + 1)] ?? 1)
    const dev = values.map((v) => Math.round((v - 1) * 1000) / 10)
    const o = baseOption(palette, narrow)
    return {
      ...o,
      xAxis: { ...(o.xAxis as object), boundaryGap: true, data: MONTHS },
      yAxis: { ...(o.yAxis as object), axisLabel: { ...(o.yAxis as { axisLabel: object }).axisLabel, formatter: (v: number) => (v > 0 ? '+' : '') + v + '%' } },
      tooltip: {
        ...(o.tooltip as object),
        axisPointer: { type: 'shadow', shadowStyle: { color: palette.surface3, opacity: 0.5 } },
        formatter: (ps: { dataIndex: number }[]) => {
          const i = ps[0]?.dataIndex ?? 0
          return tipHead(MONTHS_NOM[i], palette.text3) + tipRow(palette.forecast, 'Множитель', ratio(values[i])) + tipRow(palette.forecast, 'К обычному уровню', pct(dev[i]))
        },
      },
      series: [
        {
          type: 'bar',
          barMaxWidth: 22,
          data: dev.map((v) => ({ value: v, itemStyle: { color: palette.forecast, borderRadius: v >= 0 ? [3, 3, 0, 0] : [0, 0, 3, 3] } })),
        },
      ],
    }
  }, [palette, narrow, months])
  const days = Object.entries(special ?? {})
  return (
    <>
      <EChart option={option} height={narrow ? 200 : 230} />
      {days.length > 0 && (
        <dl className="dl" style={{ marginTop: 8 }}>
          {days.map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt>{specialDay(k)}</dt>
              <dd className="num">{ratio(v)}, {pct((v - 1) * 100, 0)} к обычному дню</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  )
}

function EventList({ rows }: { rows: EventRow[] }) {
  const sorted = [...rows].sort((a, b) => b.date_from.localeCompare(a.date_from) || a.route - b.route)
  return (
    <div className="events">
      {sorted.map((e, i) => (
        <div className="event" key={i}>
          <div className="event-top">
            {e.route ? (
              <span className="row" style={{ flexWrap: 'nowrap', gap: 6 }}><RouteDot route={e.route} /><b>{e.route}</b></span>
            ) : <b>все</b>}
            <span className="faint num">
              {e.date_from === e.date_to ? dateMid(e.date_from) : `${dateShort(e.date_from)} - ${dateMid(e.date_to)}`}, {DAYS[e.days] ?? e.days}
            </span>
            <span className="event-effect num">{Number(e.factor) === 1 ? '-' : pct((e.factor - 1) * 100, 0)}</span>
          </div>
          <div className="event-title"><Ext href={e.source_url}>{e.title}</Ext></div>
        </div>
      ))}
    </div>
  )
}

/** metrics.json is free-form beyond the fixed keys: render text, lists and flat objects as they come. */
function Free({ value }: { value: unknown }): ReactNode {
  if (value == null) return null
  if (typeof value !== 'object') return <p className="prose">{String(value)}</p>
  if (Array.isArray(value)) {
    if (value.every((x) => typeof x !== 'object')) return <ul className="prose list">{value.map((x, i) => <li key={i}>{String(x)}</li>)}</ul>
    const cols = [...new Set(value.flatMap((x) => Object.keys(x ?? {})))]
    return (
      <div className="table-wrap">
        <table className="tbl">
          <thead><tr>{cols.map((c) => <th key={c} className="l">{c}</th>)}</tr></thead>
          <tbody>
            {value.map((row, i) => (
              <tr key={i}>{cols.map((c) => <td key={c} className="l wrap">{String((row as Record<string, unknown>)[c] ?? '')}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }
  const o = value as Record<string, unknown>
  const rest = Object.entries(o).filter(([k]) => k !== 'title' && k !== 'text' && k !== 'items')
  return (
    <div className="stack" style={{ gap: 8 }}>
      {typeof o.text === 'string' && <p className="prose">{o.text}</p>}
      {Array.isArray(o.items) && <Free value={o.items} />}
      {rest.length > 0 && (
        <dl className="dl">
          {rest.map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt>{k}</dt>
              <dd>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

const TYPE: Record<string, string> = { holiday: 'Праздник', saturday: 'Суббота', sunday: 'Воскресенье', workday: 'Рабочий день' }

function CalendarList({ rows }: { rows: CalendarRow[] }) {
  // consecutive days with the same meaning collapse into one line
  const items: { from: string; to: string; what: string }[] = []
  const push = (date: string, what: string) => {
    const last = items[items.length - 1]
    if (last && last.what === what && addDays(last.to, 1) === date) last.to = date
    else items.push({ from: date, to: date, what })
  }
  const breaks: { from: string; to: string; what: string }[] = []
  for (const r of rows) {
    if (Number(r.is_holiday)) push(r.date, r.note ? `Праздник: ${r.note}` : 'Праздник')
    else if (Number(r.is_preholiday)) push(r.date, 'Предпраздничный, короткий день')
    else if (r.note) push(r.date, r.day_type === 'workday' ? `Рабочий день: ${r.note}` : `${TYPE[r.day_type] ?? r.day_type}: ${r.note}`)
    if (Number(r.school_break)) {
      const last = breaks[breaks.length - 1]
      if (last && addDays(last.to, 1) === r.date) last.to = r.date
      else breaks.push({ from: r.date, to: r.date, what: 'Школьные каникулы' })
    }
  }
  const all = [...items, ...breaks].sort((a, b) => a.from.localeCompare(b.from))
  if (!all.length) return <Empty text="Особых дней в периоде нет." />
  return (
    <div className="table-wrap">
      <table className="tbl">
        <tbody>
          {all.map((x) => (
            <tr key={x.from + x.what}>
              <td className="num">{x.from === x.to ? dateMid(x.from) : `${dateShort(x.from)} - ${dateMid(x.to)}`}</td>
              <td className="l wrap">{x.what}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="table-note" style={{ padding: '0 12px 8px' }}>Праздничных и предпраздничных дней: {fmt(rows.filter((r) => Number(r.is_holiday) || Number(r.is_preholiday)).length)}</p>
    </div>
  )
}
