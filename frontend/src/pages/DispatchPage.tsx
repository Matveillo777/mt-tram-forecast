import { useMemo, useState } from 'react'
import { useApi, type DispatchHour, type DispatchResp } from '../api'
import { baseOption, EChart, tipHead, tipRow } from '../chart'
import { dateWithDay, fmt, fmt1, hh } from '../format'
import { useApp } from '../theme'
import { Busy, DateStepper, Empty, ErrorState, Legend, Loading, Popover, RiskLabel, RouteSelect, Stat, Stepper, useNarrow } from '../ui'

export default function DispatchPage() {
  const { meta, palette } = useApp()
  const narrow = useNarrow()
  // start on the busiest route, where the plan is most likely to fall short
  const [route, setRoute] = useState(meta.routes.includes(17) ? 17 : meta.routes[0])
  const [date, setDate] = useState(meta.today)
  const [capacity, setCapacity] = useState(190)
  const [peakShare, setPeakShare] = useState(35)
  const [planned, setPlanned] = useState(8)

  const res = useApi<DispatchResp>('/dispatch', { route, date, capacity, peakShare: peakShare / 100, plannedPerHour: planned }, 150)
  const hours: DispatchHour[] = res.data ? (Array.isArray(res.data) ? res.data : res.data.hours) : []
  // night hours without passengers only add noise to the table
  const active = hours.filter((h) => Math.round(h.p90) > 0)

  const sum = useMemo(() => {
    const need = hours.reduce((a, h) => a + h.trips_needed, 0)
    const over = hours.filter((h) => h.risk === 'overload')
    const tight = hours.filter((h) => h.risk === 'tight')
    const peak = hours.reduce<DispatchHour | null>((a, h) => (!a || h.peak_load > a.peak_load ? h : a), null)
    return { need, over, tight, peak, plan: hours.reduce((a, h) => a + h.planned, 0) }
  }, [hours])

  const option = useMemo(() => {
    if (!hours.length) return null
    const o = baseOption(palette, narrow)
    const color = (h: DispatchHour) => (h.risk === 'overload' ? palette.accent : h.risk === 'tight' ? palette.tight : palette.forecast)
    return {
      ...o,
      xAxis: { ...(o.xAxis as object), boundaryGap: true, data: hours.map((h) => String(h.hour).padStart(2, '0')), axisLabel: { ...(o.xAxis as { axisLabel: object }).axisLabel, interval: narrow ? 5 : 2 } },
      yAxis: { ...(o.yAxis as object), minInterval: 1 },
      tooltip: {
        ...(o.tooltip as object),
        axisPointer: { type: 'shadow', shadowStyle: { color: palette.surface3, opacity: 0.5 } },
        formatter: (ps: { dataIndex: number }[]) => {
          const h = hours[ps[0]?.dataIndex ?? 0]
          return (
            tipHead(`${hh(h.hour)}, ${riskText[h.risk]}`, palette.text3) +
            tipRow(color(h), 'Нужно рейсов', fmt(h.trips_needed)) +
            tipRow(palette.fact, 'В плане', fmt(h.planned)) +
            tipRow(palette.text3, 'Пиковая загрузка', fmt(h.peak_load) + ' чел.')
          )
        },
      },
      series: [
        {
          name: 'Нужно рейсов',
          type: 'bar',
          barMaxWidth: 18,
          data: hours.map((h) => ({ value: h.trips_needed, itemStyle: { color: color(h), borderRadius: [4, 4, 0, 0] } })),
        },
        {
          name: 'План',
          type: 'line',
          step: 'middle',
          symbol: 'none',
          data: hours.map((h) => h.planned),
          lineStyle: { color: palette.fact, width: 2 },
          z: 3,
        },
      ],
    }
  }, [hours, palette, narrow])

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Выпуск на линию</h1>
          <p>Сколько рейсов в час нужно, чтобы пиковая загрузка вагона не превысила вместимость. Считается по верхней границе прогноза p90.</p>
        </div>
      </div>

      <div className="toolbar filters">
        <RouteSelect value={route} onChange={setRoute} />
        <DateStepper value={date} onChange={setDate} min={meta.forecast_from} max={meta.forecast_to} label="Дата выпуска" />
        <div className="inline-field">
          <span>План, рейсов в час</span>
          <Stepper value={planned} onChange={setPlanned} min={0} max={60} label="Плановое число рейсов в час" />
        </div>
        <Popover label={`Вагон ${capacity} мест · пик ${peakShare}%`} title="Параметры расчёта" align={narrow ? 'left' : 'right'}>
          <div className="stack" style={{ gap: 12 }}>
            <div className="field">
              <span>Вместимость вагона, человек</span>
              <Stepper value={capacity} onChange={setCapacity} min={20} max={400} step={10} label="Вместимость вагона" />
            </div>
            <div className="field">
              <span>Доля пассажиров часа на пиковом перегоне, %</span>
              <Stepper value={peakShare} onChange={setPeakShare} min={5} max={100} step={5} label="Доля пикового перегона" />
            </div>
            <p className="note">Пиковая загрузка = p90 × доля пикового перегона. Рейсов нужно = загрузка / вместимость, с округлением вверх.</p>
          </div>
        </Popover>
      </div>

      {res.error ? (
        <div className="card"><ErrorState message={res.error} onRetry={res.reload} height={360} /></div>
      ) : !res.data ? (
        <Loading height={420} />
      ) : !option ? (
        <div className="card"><Empty text="Нет данных для расчёта на эту дату." height={300} /></div>
      ) : (
        <Busy busy={res.loading}>
          <div className="stack">
            <div className="stats">
              <Stat label="Нужно рейсов за сутки" value={fmt(sum.need)} sub={`в плане ${fmt(sum.plan)}`} />
              <Stat label="Часы с перегрузом" value={sum.over.length} sub={sum.over.length ? sum.over.map((h) => hh(h.hour)).slice(0, 4).join(', ') + (sum.over.length > 4 ? '...' : '') : 'плана хватает'} signal={sum.over.length > 0} />
              <Stat label="Впритык" value={sum.tight.length} sub="нужно больше 85% плана" />
              <Stat label="Пиковая загрузка" value={sum.peak ? fmt(sum.peak.peak_load) : '-'} sub={sum.peak ? `в ${hh(sum.peak.hour)}, человек` : ''} />
            </div>

            <div className="card">
              <div className="card-head">
                <h2>Рейсы по часам · {dateWithDay(date)}</h2>
                <Legend
                  items={[
                    { label: 'Нужно', color: palette.forecast, kind: 'dot' },
                    { label: 'Впритык', color: palette.tight, kind: 'dot' },
                    { label: 'Перегруз', color: palette.accent, kind: 'dot' },
                    { label: 'План', color: palette.fact },
                  ]}
                />
              </div>
              <EChart option={option} height={narrow ? 240 : 300} />
            </div>

            <div className="card">
              <div className="card-head">
                <h2>Рекомендации</h2>
                <span className="hint">часы без пассажиров скрыты</span>
              </div>
              <div className="table-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Час</th>
                      <th className="opt">Медиана</th>
                      <th>p90</th>
                      <th className="opt">Пик, чел.</th>
                      <th>Нужно</th>
                      <th className="opt">Интервал</th>
                      <th className="opt">План</th>
                      <th className="l">Оценка</th>
                    </tr>
                  </thead>
                  <tbody>
                    {active.map((h) => (
                      <tr key={h.hour} className={'risk-' + h.risk}>
                        <td>{hh(h.hour)}</td>
                        <td className="faint opt">{fmt(h.p50)}</td>
                        <td>{fmt(h.p90)}</td>
                        <td className="opt">{fmt(h.peak_load)}</td>
                        <td><b>{fmt(h.trips_needed)}</b></td>
                        <td className="opt">{h.trips_needed > 0 ? `${fmt1(h.interval_min)} мин` : '-'}</td>
                        <td className="opt">{fmt(h.planned)}</td>
                        <td className="l"><RiskLabel risk={h.risk} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </Busy>
      )}
    </div>
  )
}

const riskText = { ok: 'план с запасом', tight: 'впритык', overload: 'перегруз' }
