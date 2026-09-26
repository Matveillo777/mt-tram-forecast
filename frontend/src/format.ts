const int = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 })
const one = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 })
const dayMonth = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' })
const dayMonthShort = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' })
const full = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
const dayMonthYear = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })
const weekday = new Intl.DateTimeFormat('ru-RU', { weekday: 'short' })
const monthYear = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' })
const monthShort = new Intl.DateTimeFormat('ru-RU', { month: 'short', year: '2-digit' })

export const fmt = (n: number | null | undefined) => (n == null || Number.isNaN(n) ? '-' : int.format(n))
export const fmt1 = (n: number | null | undefined) => (n == null || Number.isNaN(n) ? '-' : one.format(n))

export function compact(n: number) {
  const a = Math.abs(n)
  if (a >= 1e6) return one.format(n / 1e6) + ' млн'
  if (a >= 1e4) return one.format(n / 1e3) + ' тыс.'
  return int.format(n)
}

/** "146 - 226 тыс.": both ends in the unit of the larger one, so the pair fits a stat tile. */
export function compactRange(lo: number, hi: number) {
  const a = Math.max(Math.abs(lo), Math.abs(hi))
  if (a >= 1e6) return `${one.format(lo / 1e6)} - ${one.format(hi / 1e6)} млн`
  if (a >= 1e4) return `${int.format(lo / 1e3)} - ${int.format(hi / 1e3)} тыс.`
  return `${int.format(lo)} - ${int.format(hi)}`
}

export function pct(n: number, digits = 1) {
  const s = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(Math.abs(n))
  return (n > 0 ? '+' : n < 0 ? '-' : '') + s + '%'
}

export function parseDate(s: string) {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function isoDate(d: Date) {
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function addDays(s: string, n: number) {
  const d = parseDate(s)
  d.setDate(d.getDate() + n)
  return isoDate(d)
}

export function diffDays(a: string, b: string) {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 86400000)
}

export const clampDate = (s: string, lo: string, hi: string) => (s < lo ? lo : s > hi ? hi : s)

export const dateLong = (s: string) => full.format(parseDate(s))
export const dateShort = (s: string) => dayMonthShort.format(parseDate(s)).replace('.', '')
export const dateMid = (s: string) => dayMonthYear.format(parseDate(s)).replace(/\s?г\.?$/, '').replace(/\./g, '')
export const dateWithDay = (s: string) => `${weekday.format(parseDate(s))}, ${dayMonth.format(parseDate(s))}`

export const hh = (h: number) => String(h).padStart(2, '0') + ':00'

/** Axis/table label for a series bucket: `2025-11-01T07:00`, `2025-11-01` or `2025-11`. */
export function periodLabel(t: string, gran: 'hour' | 'day' | 'month', short = false) {
  if (gran === 'hour') {
    const time = t.slice(11, 16)
    return short ? time : `${dateShort(t)} ${time}`
  }
  if (gran === 'day') return short ? dateShort(t) : `${weekday.format(parseDate(t))}, ${dateShort(t)}`
  const d = parseDate(t + '-01')
  return short ? monthShort.format(d) : monthYear.format(d)
}

export function plural(n: number, one: string, few: string, many: string) {
  const a = Math.abs(n) % 100
  const b = a % 10
  if (a > 10 && a < 20) return many
  if (b > 1 && b < 5) return few
  if (b === 1) return one
  return many
}
