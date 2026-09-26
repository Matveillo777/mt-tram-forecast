import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Icon, type IconName } from './icons'
import { routeVar, useApp } from './theme'
import { addDays, clampDate } from './format'

export function Popover({ label, children, align = 'left', title, disabled, icon }: {
  label: ReactNode
  children: ReactNode | ((close: () => void) => ReactNode)
  align?: 'left' | 'right' | 'up'
  title?: string
  disabled?: boolean
  icon?: IconName
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  const close = () => setOpen(false)
  return (
    <div className="pop-wrap" ref={ref}>
      <button type="button" className="btn" aria-expanded={open} aria-haspopup="dialog" disabled={disabled} onClick={() => setOpen((o) => !o)}>
        {icon && <Icon name={icon} size={18} />}
        {label}
        <Icon name="down" size={16} className="caret" />
      </button>
      {open && (
        <div className={'pop ' + (align === 'left' ? '' : align)} role="dialog">
          {title && <p className="pop-title">{title}</p>}
          {typeof children === 'function' ? children(close) : children}
        </div>
      )}
    </div>
  )
}

export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T
  options: { value: T; label: string; disabled?: boolean }[]
  onChange: (v: T) => void
  label?: string
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button type="button" key={o.value} aria-pressed={o.value === value} disabled={o.disabled} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Range({ value, min, max, step = 1, onChange, label, zero }: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  label: string
  zero?: number
}) {
  const p = ((value - min) / (max - min || 1)) * 100
  const style = { '--p': p + '%' } as CSSProperties
  let cls = 'range'
  if (zero !== undefined) {
    ;(style as Record<string, string>)['--c0'] = ((zero - min) / (max - min || 1)) * 100 + '%'
    cls += ' centered'
    if (value !== zero) cls += ' changed'
  }
  return (
    <div className={cls} style={style}>
      <span className="range-fill" />
      <input type="range" min={min} max={max} step={step} value={value} aria-label={label} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  )
}

export function Stat({ label, value, sub, signal, children }: { label: ReactNode; value: ReactNode; sub?: ReactNode; signal?: boolean; children?: ReactNode }) {
  return (
    <div className={'stat' + (signal ? ' signal' : '')}>
      <div className="stat-label">{label}</div>
      <div className="stat-value num">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
      {children}
    </div>
  )
}

export function Loading({ height = 220, label = 'Загружаем данные' }: { height?: number; label?: string }) {
  return (
    <div className="state" style={{ minHeight: height }} role="status">
      <span className="spinner" />
      <span>{label}</span>
    </div>
  )
}

export function ErrorState({ message, onRetry, height = 220 }: { message: string; onRetry?: () => void; height?: number }) {
  return (
    <div className="state error" style={{ minHeight: height }} role="alert">
      <Icon name="alert" size={24} />
      <b>Не удалось получить данные</b>
      <span className="detail">{message}</span>
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry} style={{ marginTop: 8 }}>
          <Icon name="refresh" size={16} /> Повторить
        </button>
      )}
    </div>
  )
}

export function Empty({ text, height = 220 }: { text: string; height?: number }) {
  return (
    <div className="state" style={{ minHeight: height }}>
      <Icon name="info" size={24} />
      <span>{text}</span>
    </div>
  )
}

export function Banner({ children }: { children: ReactNode }) {
  return (
    <div className="banner" role="alert">
      <Icon name="alert" size={16} />
      <span>{children}</span>
    </div>
  )
}

/** Wraps content that is being refreshed: dims it instead of replacing with a spinner. */
export function Busy({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <div className="busy" data-busy={busy} aria-busy={busy}>
      {children}
    </div>
  )
}

export function RouteDot({ route, size = 10 }: { route: number; size?: number }) {
  return <span className="swatch dot" style={{ '--c': routeVar(route), width: size, height: size } as CSSProperties} />
}

/** Multi-select of routes in a popover. Empty selection means all routes. */
export function RoutePicker({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  const { meta, routeName } = useApp()
  const all = value.length === 0 || value.length === meta.routes.length
  const label = all ? 'Все маршруты' : value.length <= 3 ? 'Маршрут ' + value.join(', ') : `${value.length} маршрутов`
  const toggle = (r: number) => {
    const cur = all ? [] : value
    const next = cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r].sort((a, b) => a - b)
    onChange(next.length === meta.routes.length ? [] : next)
  }
  return (
    <Popover label={<span>{label}</span>} icon="tram" title="Маршруты">
      <div className="pop-list">
        <button type="button" className="pop-item" onClick={() => onChange([])}>
          <span className="check">{all && <Icon name="check" size={16} />}</span>
          Все маршруты
        </button>
        {meta.routes.map((r) => (
          <button type="button" key={r} className="pop-item" onClick={() => toggle(r)}>
            <span className="check">{!all && value.includes(r) && <Icon name="check" size={16} />}</span>
            <RouteDot route={r} />
            <b>{r}</b>
            <span className="sub">{routeName(r)}</span>
          </button>
        ))}
      </div>
    </Popover>
  )
}

export function RouteSelect({ value, onChange, label = 'Маршрут' }: { value: number; onChange: (r: number) => void; label?: string }) {
  const { meta, routeName } = useApp()
  return (
    <select className="select" aria-label={label} value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {meta.routes.map((r) => (
        <option key={r} value={r}>
          {r} · {routeName(r)}
        </option>
      ))}
    </select>
  )
}

export function Legend({ items }: { items: { label: string; color: string; kind?: 'line' | 'band' | 'dot' }[] }) {
  return (
    <div className="legend">
      {items.map((i) => (
        <span key={i.label}>
          <span className={'swatch ' + (i.kind ?? 'line')} style={{ '--c': i.color } as CSSProperties} />
          {i.label}
        </span>
      ))}
    </div>
  )
}

export function RiskLabel({ risk }: { risk: 'ok' | 'tight' | 'overload' }) {
  const map = {
    ok: { icon: 'ok' as const, text: 'Норма' },
    tight: { icon: 'info' as const, text: 'Впритык' },
    overload: { icon: 'alert' as const, text: 'Перегруз' },
  }
  const m = map[risk]
  return (
    <span className={'risk ' + risk}>
      <Icon name={m.icon} size={16} />
      {m.text}
    </span>
  )
}

export function useMedia(query: string) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const m = window.matchMedia(query)
    const on = () => setMatch(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [query])
  return match
}

export const useNarrow = () => useMedia('(max-width: 520px)')

/** Date input with previous/next day buttons, clamped to [min, max]. */
export function DateStepper({ value, onChange, min, max, label }: { value: string; onChange: (d: string) => void; min: string; max: string; label: string }) {
  const step = (n: number) => onChange(clampDate(addDays(value, n), min, max))
  return (
    <div className="date-step">
      <button type="button" className="btn btn-icon" aria-label="Предыдущий день" disabled={value <= min} onClick={() => step(-1)}>
        <Icon name="left" size={18} />
      </button>
      <input
        type="date"
        className="input"
        aria-label={label}
        value={value}
        min={min}
        max={max}
        onChange={(e) => e.target.value && onChange(clampDate(e.target.value, min, max))}
      />
      <button type="button" className="btn btn-icon" aria-label="Следующий день" disabled={value >= max} onClick={() => step(1)}>
        <Icon name="right" size={18} />
      </button>
    </div>
  )
}

export function Stepper({ value, onChange, min, max, label, step = 1 }: { value: number; onChange: (v: number) => void; min: number; max: number; label: string; step?: number }) {
  const set = (v: number) => onChange(Math.min(max, Math.max(min, Math.round(v * 100) / 100)))
  return (
    <div className="stepper">
      <button type="button" className="btn btn-icon" aria-label="Меньше" disabled={value <= min} onClick={() => set(value - step)}>
        <Icon name="minus" size={16} />
      </button>
      <input
        className="input num"
        inputMode="decimal"
        aria-label={label}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value.replace(',', '.'))
          if (!Number.isNaN(v)) set(v)
        }}
      />
      <button type="button" className="btn btn-icon" aria-label="Больше" disabled={value >= max} onClick={() => set(value + step)}>
        <Icon name="plus" size={16} />
      </button>
    </div>
  )
}
