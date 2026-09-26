import { useEffect, useState } from 'react'

export const API = '/api/v1'

export type Params = Record<string, string | number | boolean | null | undefined>

export interface Meta {
  today: string
  forecast_from: string
  forecast_to: string
  history_from: string
  history_to: string
  routes: number[]
  horizons: string[]
  granularities: string[]
}

export interface RouteInfo {
  route: number
  name: string
  color: string
  stops_count: number
}

export interface Stop {
  stop_id: string
  name: string
  lat: number
  lon: number
  seq: number
  terminal: boolean
  near_rail: boolean
}

export interface RouteFull extends Omit<RouteInfo, 'stops_count'> {
  stops: Stop[]
}

export interface ForecastPoint {
  t: string
  p10: number
  p50: number
  p90: number
  value: number
}

export interface ForecastResp {
  horizon: string
  from: string
  to: string
  granularity: 'hour' | 'day' | 'month'
  routes: number[]
  stop: string | null
  /** corrected p50 over base p50 for the whole selection */
  multiplier: number
  /** the same, with only one factor of the scenario applied */
  factor_effects: Record<EffectKey, number>
  series: ForecastPoint[]
  total: { p10: number; p50: number; p90: number; value: number }
}

export interface HistoryResp {
  series: { t: string; actual: number }[]
  total: { actual: number }
}

export interface MapResp {
  date: string
  hour: number | null
  kind?: 'forecast' | 'history'
  routes: { route: number; value: number; stops: { stop_id: string; value: number }[] }[]
}

export interface DispatchHour {
  hour: number
  p50: number
  p90: number
  peak_load: number
  trips_needed: number
  interval_min: number
  planned: number
  risk: 'ok' | 'tight' | 'overload'
}

export type DispatchResp = DispatchHour[] | { hours: DispatchHour[] }

export interface LiveResp {
  date: string
  updated_at: string
  demo?: boolean
  source?: string
  /** simulated time of day of the demo stream, HH:MM */
  sim_time?: string | null
  routes: { route: number; actual_total: number; forecast_total: number | null; hours: { hour: number; actual: number; forecast: number | null }[] }[]
}

export type FactorKey = 'temp_delta' | 'precip_mm' | 'snow_cm' | 'event_pct' | 'season_pct'
export type EffectKey = 'temp' | 'precip' | 'snow' | 'event' | 'season'

export interface Factors {
  weather: {
    coef: Record<'rain_warm' | 'rain_we' | 'snow' | 'heat' | 'cold', number>
    rain_warm_min_t: number
    heat_above_t: number
    cold_below_t: number
  }
  formula?: string
  limits: Record<FactorKey, [number, number]>
  presets: ({ id: string; title: string } & Record<FactorKey, number>)[]
  note?: string
}

export interface ModelInfo {
  model: { name: string; description: string; features: string[] }
  backtests: { name: string; origin: string; horizon_days: number; wape_score: number }[]
  by_route: { route: number; wape_score: number }[]
  external_effects: { source: string; metric: string; without: number; with: number; delta: number; note: string; url: string }[]
  [k: string]: unknown
}

export interface CalendarRow {
  date: string
  day_type: string
  is_holiday: number
  is_preholiday: number
  school_break: number
  note: string
}

export interface EventRow {
  route: number
  date_from: string
  date_to: string
  days: string
  factor: number
  title: string
  source_url: string
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function qs(params?: Params): string {
  if (!params) return ''
  const u = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    u.set(k, String(v))
  }
  const s = u.toString()
  return s ? '?' + s : ''
}

export function url(path: string, params?: Params) {
  return API + path + qs(params)
}

async function problem(res: Response): Promise<ApiError> {
  let detail = ''
  try {
    const body = await res.json()
    detail = body.detail || body.title || ''
  } catch {
    // not json, keep the generic message
  }
  if (!detail) detail = res.status >= 500 ? `Сервер вернул ошибку ${res.status}` : `Запрос отклонён (${res.status})`
  return new ApiError(res.status, detail)
}

export async function getJson<T>(path: string, params?: Params, signal?: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await fetch(url(path, params), { signal, headers: { Accept: 'application/json, application/geo+json, application/problem+json' } })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new ApiError(0, 'Сервер недоступен. Проверьте, что backend запущен.')
  }
  if (!res.ok) throw await problem(res)
  return res.json() as Promise<T>
}

export async function postBody<T>(path: string, body: BodyInit, contentType: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(API + path, { method: 'POST', body, headers: { 'Content-Type': contentType } })
  } catch {
    throw new ApiError(0, 'Сервер недоступен. Проверьте, что backend запущен.')
  }
  if (!res.ok) throw await problem(res)
  return res.json() as Promise<T>
}

/** Fetches a file and hands it to the browser, so API errors can be shown instead of a broken download. */
export async function download(path: string, params: Params, fallbackName: string) {
  let res: Response
  try {
    res = await fetch(url(path, params))
  } catch {
    throw new ApiError(0, 'Сервер недоступен. Проверьте, что backend запущен.')
  }
  if (!res.ok) throw await problem(res)
  const name = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(res.headers.get('Content-Disposition') ?? '')?.[1]
  const href = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = href
  a.download = name ? decodeURIComponent(name) : fallbackName
  a.click()
  setTimeout(() => URL.revokeObjectURL(href), 1000)
}

export function errorText(e: unknown) {
  return e instanceof Error ? e.message : 'Неизвестная ошибка'
}

export interface Loadable<T> {
  data?: T
  error?: string
  loading: boolean
  reload: () => void
}

/**
 * Fetches `path` whenever it or its params change. Keeps the previous data while
 * the next request is in flight, so charts do not blink on every filter change.
 * Pass path = null to skip the request.
 */
export function useApi<T>(path: string | null, params?: Params, debounceMs = 0): Loadable<T> {
  const key = path === null ? null : path + qs(params)
  const [tick, setTick] = useState(0)
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: key !== null })

  useEffect(() => {
    if (key === null) {
      setState({ loading: false })
      return
    }
    const ctl = new AbortController()
    setState((s) => ({ data: s.data, loading: true }))
    const timer = setTimeout(() => {
      getJson<T>(path!, params, ctl.signal).then(
        (data) => setState({ data, loading: false }),
        (e) => {
          if (!ctl.signal.aborted) setState({ error: errorText(e), loading: false })
        },
      )
    }, debounceMs)
    return () => {
      clearTimeout(timer)
      ctl.abort()
    }
  }, [key, tick, debounceMs])

  return { ...state, reload: () => setTick((t) => t + 1) }
}
