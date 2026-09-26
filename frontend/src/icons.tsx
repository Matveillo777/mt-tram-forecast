import type { SVGProps } from 'react'

// One stroke weight, one grid (20x20), drawn by hand for this app.
const paths = {
  map: 'M3 5.5l4.5-2 5 2 4.5-2v11l-4.5 2-5-2-4.5 2v-11zM7.5 3.5v11M12.5 5.5v11',
  forecast: 'M3 16.5h14M4 13l3.5-4 3 2.5L16 5M13 5h3v3',
  sliders: 'M4 5.5h7M15 5.5h1M4 10h2M10 10h6M4 14.5h8M16 14.5h0M13 3.5v4M8 8v4M14 12.5v4',
  tram: 'M6 3.5h8M10 3.5v2.5M5.5 6h9a1 1 0 011 1v7a1.5 1.5 0 01-1.5 1.5H6A1.5 1.5 0 014.5 14V7a1 1 0 011-1zM4.5 10.5h11M7.5 13h0M12.5 13h0M7 15.5l-1.5 2M13 15.5l1.5 2',
  live: 'M2.5 10h3l2-5 3.5 10 2-5h4.5',
  model: 'M10 17a7 7 0 100-14 7 7 0 000 14zM10 13.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM10 10h0',
  settings: 'M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4',
  menu: 'M3.5 6h13M3.5 10h13M3.5 14h13',
  close: 'M5 5l10 10M15 5L5 15',
  play: 'M7 4.5v11l9-5.5-9-5.5z',
  pause: 'M7 4.5v11M13 4.5v11',
  left: 'M12 4.5L6.5 10l5.5 5.5',
  right: 'M8 4.5l5.5 5.5L8 15.5',
  down: 'M5.5 8l4.5 4.5L14.5 8',
  check: 'M4.5 10.5l3.5 3.5 7.5-8',
  download: 'M10 3.5v9M6 9l4 4 4-4M4 16.5h12',
  upload: 'M10 13V4M6 8l4-4 4 4M4 16.5h12',
  alert: 'M10 3l7.5 13.5h-15L10 3zM10 8.5v3.5M10 14.5h0',
  info: 'M10 17a7 7 0 100-14 7 7 0 000 14zM10 9v4.5M10 6.5h0',
  calendar: 'M4 5h12v11.5H4zM4 8.5h12M7.5 3v3.5M12.5 3v3.5',
  clock: 'M10 17a7 7 0 100-14 7 7 0 000 14zM10 6v4l2.5 2.5',
  history: 'M3.5 10a6.5 6.5 0 106.5-6.5c-2.3 0-4 1-5.3 2.7M3.5 3.5v3h3M10 6.5V10l2.5 1.5',
  external: 'M8.5 4.5h-4v11h11v-4M11.5 3.5h5v5M16.5 3.5L9 11',
  sun: 'M10 13.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM10 2v1.5M10 16.5V18M2 10h1.5M16.5 10H18M4.3 4.3l1.1 1.1M14.6 14.6l1.1 1.1M4.3 15.7l1.1-1.1M14.6 5.4l1.1-1.1',
  moon: 'M16 12.5A6.5 6.5 0 017.5 4a6.5 6.5 0 108.5 8.5z',
  monitor: 'M3 4.5h14v9H3zM7 16.5h6M10 13.5v3',
  refresh: 'M16 10a6 6 0 11-1.8-4.3M16.5 3.5v3.5H13',
  ok: 'M10 17a7 7 0 100-14 7 7 0 000 14zM7 10.2l2 2 4-4.4',
  minus: 'M5 10h10',
  plus: 'M10 5v10M5 10h10',
  file: 'M5.5 2.5h6l3.5 3.5v11.5h-9.5zM11.5 2.5V6H15',
}

export type IconName = keyof typeof paths

export function Icon({ name, size = 20, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  const filled = name === 'play'
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={paths[name]} />
    </svg>
  )
}

export function BrandMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 15.5c3-1 4-9.5 7-9.5s4 8.5 7 9.5" />
      <path d="M3 17.5h14" />
    </svg>
  )
}
