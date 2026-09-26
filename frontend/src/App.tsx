import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { useApi, type Meta, type RouteInfo } from './api'
import { AppContext, readPalette, useThemePref, type ThemePref } from './theme'
import { BrandMark, Icon, type IconName } from './icons'
import { ErrorState, Loading, Popover, Segmented } from './ui'
import { dateLong } from './format'

const pages = {
  map: { title: 'Карта', icon: 'map', view: lazy(() => import('./pages/MapPage')) },
  forecast: { title: 'Прогноз', icon: 'forecast', view: lazy(() => import('./pages/ForecastPage')) },
  scenarios: { title: 'Сценарии', icon: 'sliders', view: lazy(() => import('./pages/ScenarioPage')) },
  dispatch: { title: 'Выпуск', icon: 'tram', view: lazy(() => import('./pages/DispatchPage')) },
  live: { title: 'Онлайн', icon: 'live', view: lazy(() => import('./pages/LivePage')) },
  model: { title: 'Модель', icon: 'model', view: lazy(() => import('./pages/ModelPage')) },
} satisfies Record<string, { title: string; icon: IconName; view: unknown }>

type PageId = keyof typeof pages

function pageFromHash(): PageId {
  const id = location.hash.replace(/^#\/?/, '').split('?')[0]
  return id in pages ? (id as PageId) : 'map'
}

export default function App() {
  const [page, setPage] = useState<PageId>(pageFromHash)
  const [navOpen, setNavOpen] = useState(false)
  const { pref, setPref, theme } = useThemePref()
  const palette = useMemo(() => readPalette(), [theme])
  const meta = useApi<Meta>('/meta')
  const routes = useApi<RouteInfo[]>('/routes')

  useEffect(() => {
    const on = () => {
      setPage(pageFromHash())
      setNavOpen(false)
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])

  useEffect(() => {
    document.title = `${pages[page].title} · Загрузка трамваев`
  }, [page])

  const ctx = useMemo(() => {
    if (!meta.data || !routes.data) return null
    const names = new Map(routes.data.map((r) => [r.route, r.name]))
    return {
      meta: meta.data,
      routes: routes.data,
      theme,
      palette,
      routeName: (r: number) => names.get(r) ?? `Маршрут ${r}`,
    }
  }, [meta.data, routes.data, theme, palette])

  const View = pages[page].view
  const failed = meta.error || routes.error

  return (
    <div className="app">
      <header className="topbar">
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Открыть меню" onClick={() => setNavOpen(true)}>
          <Icon name="menu" />
        </button>
        <span className="title">{pages[page].title}</span>
      </header>
      <div className={'scrim' + (navOpen ? ' open' : '')} onClick={() => setNavOpen(false)} />
      <aside className={'rail' + (navOpen ? ' open' : '')} aria-label="Разделы">
        <div className="brand">
          <span className="brand-mark"><BrandMark /></span>
          <div>
            <div className="brand-name">Загрузка трамваев</div>
            <div className="brand-sub">прогноз пассажиропотока</div>
          </div>
        </div>
        <nav className="nav">
          {(Object.keys(pages) as PageId[]).map((id) => (
            <a key={id} href={'#/' + id} className="nav-item" aria-current={id === page ? 'page' : undefined}>
              <Icon name={pages[id].icon} />
              {pages[id].title}
            </a>
          ))}
        </nav>
        <div className="rail-foot">
          {meta.data && (
            <div className="today">
              Дата сервиса
              <b>{dateLong(meta.data.today)}</b>
              факт до {dateLong(meta.data.history_to)}
            </div>
          )}
          <Popover label="Настройки" icon="settings" align="up" title="Тема оформления">
            <Segmented<ThemePref>
              label="Тема"
              value={pref}
              onChange={setPref}
              options={[
                { value: 'system', label: 'Как в системе' },
                { value: 'light', label: 'Светлая' },
                { value: 'dark', label: 'Тёмная' },
              ]}
            />
          </Popover>
        </div>
      </aside>
      <main className="main">
        {failed ? (
          <div className="card">
            <ErrorState message={failed} height={360} onRetry={() => { meta.reload(); routes.reload() }} />
          </div>
        ) : !ctx ? (
          <Loading height={360} />
        ) : (
          <AppContext.Provider value={ctx}>
            <Suspense fallback={<Loading height={360} label="Открываем раздел" />}>
              <View />
            </Suspense>
          </AppContext.Provider>
        )}
      </main>
    </div>
  )
}
