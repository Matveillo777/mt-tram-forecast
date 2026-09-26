import { useEffect, useRef } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import { GridComponent, MarkLineComponent, TooltipComponent, DataZoomComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { Palette } from './theme'
import { fmt } from './format'

echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, MarkLineComponent, DataZoomComponent, CanvasRenderer])

export type Option = echarts.EChartsCoreOption

export function EChart({ option, height = 300, onClick }: { option: Option; height?: number; onClick?: (index: number) => void }) {
  const el = useRef<HTMLDivElement>(null)
  const chart = useRef<echarts.ECharts | null>(null)
  const clickRef = useRef(onClick)
  clickRef.current = onClick

  useEffect(() => {
    const c = echarts.init(el.current!, undefined, { renderer: 'canvas' })
    chart.current = c
    // click anywhere over the plot picks the nearest category, not only the tiny symbols
    c.getZr().on('click', (e) => {
      const pt = [e.offsetX, e.offsetY]
      if (!clickRef.current || !c.containPixel('grid', pt)) return
      const i = (c.convertFromPixel({ gridIndex: 0 }, pt) as number[])[0]
      if (Number.isFinite(i)) clickRef.current(Math.round(i))
    })
    const ro = new ResizeObserver(() => c.resize())
    ro.observe(el.current!)
    return () => {
      ro.disconnect()
      c.dispose()
      chart.current = null
    }
  }, [])

  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true })
  }, [option])

  return <div ref={el} className={'chart' + (onClick ? ' clickable' : '')} style={{ height }} />
}

/** Shared chrome: recessive axes, hairline grid, tooltip in app tokens. */
export function baseOption(p: Palette, narrow = false): Option {
  const label = { color: p.text3, fontSize: 13, fontFamily: 'Segoe UI, system-ui, sans-serif' }
  return {
    animationDuration: 220,
    animationDurationUpdate: 180,
    animationEasingUpdate: 'cubicOut',
    textStyle: { fontFamily: 'Segoe UI, system-ui, sans-serif' },
    grid: { left: 8, right: narrow ? 8 : 16, top: 16, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: p.surface1,
      borderColor: p.lineStrong,
      borderWidth: 1,
      padding: [8, 10],
      textStyle: { color: p.text1, fontSize: 13 },
      extraCssText: 'border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.12);',
      axisPointer: { type: 'line', lineStyle: { color: p.lineStrong, width: 1 } },
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      axisLine: { lineStyle: { color: p.lineStrong } },
      axisTick: { show: false },
      axisLabel: { ...label, hideOverlap: true },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { ...label, formatter: (v: number) => axisNum(v) },
      splitLine: { lineStyle: { color: p.line, width: 1 } },
    },
  }
}

export function axisNum(v: number) {
  if (Math.abs(v) >= 1e6) return (v / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' млн'
  if (Math.abs(v) >= 1e3) return (v / 1e3).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' тыс'
  return fmt(v)
}

/** p10..p90 band drawn as a stacked pair: invisible floor + filled height. */
export function bandSeries(name: string, lo: (number | null)[], hi: (number | null)[], color: string) {
  return [
    {
      name: name + '-floor',
      type: 'line',
      data: lo,
      stack: name,
      symbol: 'none',
      lineStyle: { opacity: 0 },
      tooltip: { show: false },
      silent: true,
    },
    {
      name,
      type: 'line',
      data: hi.map((h, i) => (h == null || lo[i] == null ? null : h - (lo[i] as number))),
      stack: name,
      symbol: 'none',
      lineStyle: { opacity: 0 },
      areaStyle: { color, opacity: 0.16 },
      tooltip: { show: false },
      silent: true,
    },
  ]
}

export function lineSeries(name: string, data: (number | null)[], color: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    type: 'line',
    data,
    symbol: 'circle',
    symbolSize: 8,
    showSymbol: false,
    lineStyle: { width: 2, color, cap: 'round', join: 'round' },
    itemStyle: { color, borderColor: 'transparent' },
    emphasis: { disabled: true },
    connectNulls: false,
    ...extra,
  }
}

/** Tooltip row in the same markup for every chart. */
export function tipRow(color: string, label: string, value: string, kind: 'line' | 'band' = 'line') {
  const sw = kind === 'band'
    ? `<span style="display:inline-block;width:12px;height:10px;border-radius:2px;background:${color};opacity:.35"></span>`
    : `<span style="display:inline-block;width:12px;height:3px;border-radius:2px;background:${color}"></span>`
  return `<div style="display:flex;align-items:center;gap:8px;line-height:1.7">${sw}<span style="flex:1">${label}</span><b style="font-variant-numeric:tabular-nums;margin-left:12px">${value}</b></div>`
}

export function tipHead(text: string, color: string) {
  return `<div style="color:${color};font-size:13px;margin-bottom:2px">${text}</div>`
}
