import {useEffect, useRef, useState} from 'react'
import {DEMO, message} from './api'
import {tenantColor, useSession} from './auth'
import {Icon, Logo} from './ui/icons'
import {useTwinData} from './useTwinData'
import {Overview} from './pages/Overview'
import {Explorer} from './pages/Explorer'
import {AttackPaths} from './pages/AttackPaths'
import {Simulations} from './pages/Simulations'
import {Research} from './pages/Research'
import {Audit} from './pages/Audit'
import {Workspace} from './pages/Workspace'
import {Hosts} from './pages/Hosts'
import {Team} from './pages/Team'
import {Platform} from './pages/Platform'
import {CompanyValidation} from './pages/CompanyValidation'

const PAGES = [
  {id: 'overview', label: 'Overview', icon: 'grid', group: 'Monitor'},
  {id: 'twin', label: '3D Twin', icon: 'cube', group: 'Monitor'},
  {id: 'hosts', label: 'Hosts', icon: 'server', group: 'Monitor'},
  {id: 'paths', label: 'Attack paths', icon: 'route', group: 'Analyze'},
  {id: 'simulations', label: 'Simulations', icon: 'flask', group: 'Analyze'},
  // TwinHunter research stays reachable by URL (#research) but is kept out of the sidebar.
  {id: 'research', label: 'TwinHunter', icon: 'spark', group: 'Analyze', hidden: true},
  {id: 'company', label: 'Company validation', icon: 'route', group: 'Analyze'},
  {id: 'team', label: 'Team', icon: 'users', group: 'Govern', admin: true},
  {id: 'workspace', label: 'Workspace', icon: 'building', group: 'Govern'},
  {id: 'audit', label: 'Access audit', icon: 'shield', group: 'Govern', admin: true},
] as const
type PageId = typeof PAGES[number]['id']

const initial = () => (PAGES.find(p => p.id === location.hash.slice(1))?.id ?? 'overview') as PageId

export function App() {
  const {principal} = useSession()
  // Remount every view on tenant change so no state can leak between workspaces.
  if (!principal.tenant) return <PlatformShell key="platform"/>
  return <Shell key={principal.tenant}/>
}

function Sidebar({children, footer}: {children: React.ReactNode; footer: React.ReactNode}) {
  return <nav className="sidebar" aria-label="Primary">
    <div className="brand"><Logo/><div><b>Digital Twin</b><small>Security graph platform</small></div></div>
    {children}
    <div className="sidebar-foot">{footer}</div>
  </nav>
}

function TopBar({live}: {live?: React.ReactNode}) {
  return <>
    {DEMO && <div className="demo-banner"><Icon name="eye" size={15}/>Demo mode — every customer, host and finding shown here is synthetic.</div>}
    <header className="topbar"><WorkspaceSwitcher/><div className="spacer"/>{live}<UserMenu/></header>
  </>
}

function PlatformShell() {
  const {principal, switchTenant} = useSession()
  return <div className="shell">
    <Sidebar footer={<><b><Icon name="lock" size={15}/>Customer data stays private</b>The console shows customer health and usage, never their twins or findings.</>}>
      <div className="nav-label">Platform</div>
      <button className="nav-item active" aria-current="page"><Icon name="building"/>Customers</button>
      {principal.tenants.length > 0 && <><div className="nav-label">Your workspaces</div>
        {principal.tenants.map(t => <button key={t.id} className="nav-item" onClick={() => void switchTenant(t.id)}>
          <span className="tenant-avatar" style={{background: tenantColor(t.id), width: 20, height: 20, fontSize: 9, borderRadius: 6}}>{t.name.slice(0, 2).toUpperCase()}</span>{t.name}</button>)}</>}
    </Sidebar>
    <div className="main"><TopBar/><main className="content"><Platform/></main></div>
  </div>
}

function Shell() {
  const {principal, switchTenant} = useSession()
  const data = useTwinData()
  const [page, setPage] = useState<PageId>(initial)
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => { const sync = () => setPage(initial()); window.addEventListener('hashchange', sync); return () => window.removeEventListener('hashchange', sync) }, [])
  const go = (id: PageId) => { location.hash = id; setPage(id) }
  const visible = PAGES.filter(p => !('admin' in p) || principal.role === 'admin')
  const current = visible.find(p => p.id === page) ?? visible[0]
  const counts: Partial<Record<PageId, number>> = {twin: data.topology.nodes.filter(n => n.labels.includes('Host')).length, hosts: data.agents.length}
  const shared = {data, selected, onSelect: setSelected, go: (id: string) => go(id as PageId)}

  return <div className="shell">
    <Sidebar footer={<><b><Icon name="shieldCheck" size={15}/>Isolated workspace</b>Data, events and sandboxes are scoped to <b style={{display: 'inline'}}>{principal.tenant}</b>.</>}>
      {(['Monitor', 'Analyze', 'Govern'] as const).map(group => <div key={group}>
        <div className="nav-label">{group}</div>
        {visible.filter(p => p.group === group && !('hidden' in p)).map(p => <button key={p.id} className={`nav-item ${current.id === p.id ? 'active' : ''}`}
          aria-current={current.id === p.id ? 'page' : undefined} onClick={() => go(p.id)}>
          <Icon name={p.icon}/>{p.label}{counts[p.id] ? <span className="count">{counts[p.id]}</span> : null}</button>)}
      </div>)}
      {principal.platform_admin && <><div className="nav-label">Platform</div>
        <button className="nav-item" onClick={() => void switchTenant('')}><Icon name="building"/>Platform console</button></>}
    </Sidebar>
    <div className="main">
      <TopBar live={<span className={`live ${data.error ? 'bad' : ''}`} role="status"><i/>{data.error ? 'Connection issue' : data.updated ? `Live · ${data.updated.toLocaleTimeString()}` : 'Connecting…'}</span>}/>
      <main className="content">
        {data.error && <div className="alert danger" role="alert"><Icon name="alert"/>{data.error}. Displayed data may be out of date.</div>}
        {current.id === 'overview' && <Overview {...shared}/>}
        {current.id === 'twin' && <Explorer {...shared}/>}
        {current.id === 'hosts' && <Hosts data={data}/>}
        {current.id === 'paths' && <AttackPaths {...shared}/>}
        {current.id === 'simulations' && <Simulations {...shared}/>}
        {current.id === 'research' && <Research/>}
        {current.id === 'company' && <CompanyValidation/>}
        {current.id === 'team' && <Team/>}
        {current.id === 'workspace' && <Workspace data={data}/>}
        {current.id === 'audit' && <Audit/>}
      </main>
    </div>
  </div>
}

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) close() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', onClick); document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onClick); document.removeEventListener('keydown', onKey) }
  }, [open, close])
  return ref
}

function WorkspaceSwitcher() {
  const {principal, switchTenant} = useSession()
  const [open, setOpen] = useState(false), [busy, setBusy] = useState<string | null>(null), [error, setError] = useState('')
  const ref = useDismiss(open, () => setOpen(false))
  const current = principal.tenant ? principal.tenants.find(t => t.id === principal.tenant) ?? {id: principal.tenant, name: principal.tenant, role: principal.role}
    : {id: 'platform', name: 'Platform console', role: 'platform admin'}
  async function choose(id: string) {
    if (id === principal.tenant) { setOpen(false); return }
    setBusy(id); setError('')
    try { await switchTenant(id); setOpen(false) } catch (e) { setError(message(e)) } finally { setBusy(null) }
  }
  return <div className="switcher" ref={ref}>
    <button className="switcher-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="tenant-avatar" style={{background: principal.tenant ? tenantColor(current.id) : 'linear-gradient(135deg, #334155, #0f172a)'}}>
        {principal.tenant ? current.name.slice(0, 2).toUpperCase() : <Icon name="building" size={15}/>}</span>
      <span className="meta"><b>{current.name}</b><small>{principal.tenant ? `${current.id} · ${current.role}` : 'all customers'}</small></span>
      <Icon name="chevron" size={16}/>
    </button>
    {open && <div className="menu" role="menu">
      {principal.platform_admin && <><div className="menu-head">Platform</div>
        <button role="menuitem" className="menu-item" disabled={busy !== null} onClick={() => void choose('')}>
          <span className="tenant-avatar" style={{background: 'linear-gradient(135deg, #334155, #0f172a)', width: 26, height: 26}}><Icon name="building" size={13}/></span>
          <span className="meta"><b>Platform console</b><small>customers and health</small></span>
          {busy === '' ? <span className="muted" style={{fontSize: 12}}>Opening…</span> : !principal.tenant && <Icon name="check" className="check"/>}</button></>}
      {principal.tenants.length > 0 && <div className="menu-head">Your workspaces</div>}
      {principal.tenants.map(t => <button key={t.id} role="menuitem" className="menu-item" disabled={busy !== null} onClick={() => void choose(t.id)}>
        <span className="tenant-avatar" style={{background: tenantColor(t.id), width: 26, height: 26, fontSize: 11}}>{t.name.slice(0, 2).toUpperCase()}</span>
        <span className="meta"><b>{t.name}</b><small>{t.id} · {t.role}</small></span>
        {busy === t.id ? <span className="muted" style={{fontSize: 12}}>Switching…</span> : t.id === principal.tenant && <Icon name="check" className="check"/>}
      </button>)}
      {error && <div className="alert danger" style={{margin: 6}}>{error}</div>}
      <div className="menu-sep"/>
      <p className="muted" style={{fontSize: 11.5, padding: '4px 10px 6px'}}>Switching re-authorizes your session for the selected workspace only.</p>
    </div>}
  </div>
}

function UserMenu() {
  const {principal, logout} = useSession()
  const [open, setOpen] = useState(false), [error, setError] = useState('')
  const ref = useDismiss(open, () => setOpen(false))
  const name = principal.display_name || principal.id
  const initials = name.split(/[\s._-]/).filter(Boolean).map(s => s[0]).join('').slice(0, 2).toUpperCase()
  return <div className="switcher" ref={ref}>
    <button className="user-btn" aria-haspopup="menu" aria-expanded={open} aria-label="Account" onClick={() => setOpen(!open)}><span className="avatar">{initials}</span></button>
    {open && <div className="menu right" role="menu" style={{minWidth: 250}}>
      <div style={{padding: '8px 10px'}}><b>{name}</b><p className="muted" style={{fontSize: 12}}>{principal.id}{principal.tenant ? ` · ${principal.role} in ${principal.tenant}` : ''}{principal.platform_admin ? ' · platform admin' : ''}</p></div>
      <div className="menu-sep"/>
      {principal.auth_mode === 'lab' ? <p className="muted" style={{fontSize: 12, padding: '6px 10px'}}>Insecure local lab mode — no sign-out.</p>
        : <button className="menu-item" role="menuitem" onClick={() => logout().catch(() => setError('Sign-out could not be confirmed.'))}><Icon name="logout"/>Sign out</button>}
      {error && <div className="alert danger" style={{margin: 6}}>{error}</div>}
    </div>}
  </div>
}
