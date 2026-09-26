import { createContext, useContext, useEffect, useState } from 'react'
import type { Meta, RouteInfo } from './api'

export type ThemePref = 'system' | 'light' | 'dark'
export type Theme = 'light' | 'dark'

const media = window.matchMedia('(prefers-color-scheme: dark)')

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem('theme')
    if (v === 'light' || v === 'dark') return v
  } catch {
    // storage may be blocked, fall back to system
  }
  return 'system'
}

export function useThemePref() {
  const [pref, setPref] = useState<ThemePref>(readPref)
  const [system, setSystem] = useState<Theme>(media.matches ? 'dark' : 'light')
  useEffect(() => {
    const on = () => setSystem(media.matches ? 'dark' : 'light')
    media.addEventListener('change', on)
    return () => media.removeEventListener('change', on)
  }, [])
  const theme: Theme = pref === 'system' ? system : pref
  // set synchronously so palette reads below see the right variables
  document.documentElement.dataset.theme = theme
  const update = (p: ThemePref) => {
    try {
      if (p === 'system') localStorage.removeItem('theme')
      else localStorage.setItem('theme', p)
    } catch {
      // ignore
    }
    setPref(p)
  }
  return { pref, setPref: update, theme }
}

// Fixed route -> palette slot. Route 5 has no boardings in the data, it stays neutral.
const ROUTE_SLOT: Record<number, number> = { 1: 1, 7: 2, 11: 3, 12: 4, 17: 5, 25: 6, 26: 7, 28: 8, 50: 9 }

export const routeVar = (route: number) => (ROUTE_SLOT[route] ? `var(--route-${ROUTE_SLOT[route]})` : 'var(--route-none)')

export interface Palette {
  surface1: string
  surface2: string
  surface3: string
  line: string
  lineStrong: string
  text1: string
  text2: string
  text3: string
  accent: string
  accentSoft: string
  tight: string
  forecast: string
  fact: string
  base: string
  load: [string, string, string]
  route: (r: number) => string
}

export function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement)
  const v = (n: string) => cs.getPropertyValue(n).trim()
  const routes: Record<number, string> = {}
  for (const [r, slot] of Object.entries(ROUTE_SLOT)) routes[Number(r)] = v(`--route-${slot}`)
  const none = v('--route-none')
  return {
    surface1: v('--surface-1'),
    surface2: v('--surface-2'),
    surface3: v('--surface-3'),
    line: v('--line'),
    lineStrong: v('--line-strong'),
    text1: v('--text-1'),
    text2: v('--text-2'),
    text3: v('--text-3'),
    accent: v('--accent'),
    accentSoft: v('--accent-soft'),
    tight: v('--risk-tight'),
    forecast: v('--series-forecast'),
    fact: v('--series-fact'),
    base: v('--series-base'),
    load: [v('--load-0'), v('--load-1'), v('--load-2')],
    route: (r) => routes[r] ?? none,
  }
}

export interface AppState {
  meta: Meta
  routes: RouteInfo[]
  theme: Theme
  palette: Palette
  routeName: (r: number) => string
}

export const AppContext = createContext<AppState | null>(null)

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('AppContext is missing')
  return ctx
}
