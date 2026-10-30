import {createContext, useCallback, useContext, useEffect, useState, type FormEvent, type ReactNode} from 'react'
import {api, ApiError, DEMO, message} from './api'
import type {Principal} from './types'
import {Icon, Logo} from './ui/icons'

type Session = {principal: Principal; switchTenant: (tenant: string) => Promise<void>; logout: () => Promise<void>}
const SessionContext = createContext<Session | null>(null)
export const useSession = () => useContext(SessionContext)!

export function tenantColor(id: string) {
  let hash = 0
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  const hues = [243, 199, 162, 271, 24, 340, 214]
  const h = hues[hash % hues.length]
  return `linear-gradient(135deg, hsl(${h} 75% 60%), hsl(${(h + 28) % 360} 80% 52%))`
}

const inviteToken = () => location.hash.match(/^#\/invite\/([A-Za-z0-9_-]+)$/)?.[1] ?? null

export function AuthShell({children}: {children: ReactNode}) {
  const [principal, setPrincipal] = useState<Principal | null>(null)
  const [loading, setLoading] = useState(true), [setup, setSetup] = useState(false)
  const [error, setError] = useState(''), [invite, setInvite] = useState(inviteToken)

  const check = useCallback(async () => {
    try { setPrincipal(await api.get<Principal>('/api/auth/session')); setError('') }
    catch (e) {
      setPrincipal(null)
      if (e instanceof ApiError && e.status === 401) {
        try { setSetup((await api.get<{needed: boolean}>('/api/setup')).needed) } catch { setSetup(false) }
      } else setError('The access service is unavailable. Retrying…')
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { void check(); const timer = setInterval(check, 30000); return () => clearInterval(timer) }, [check])
  useEffect(() => { const sync = () => setInvite(inviteToken()); window.addEventListener('hashchange', sync); return () => window.removeEventListener('hashchange', sync) }, [])

  const switchTenant = useCallback(async (tenant: string) => { setPrincipal(await api.post<Principal>('/api/auth/tenant', {tenant})) }, [])
  const logout = useCallback(async () => { await api.post('/api/auth/logout', {}); setPrincipal(null) }, [])

  if (invite) return <AcceptInvite token={invite} onDone={() => { location.hash = ''; setInvite(null); void check() }}/>
  if (loading) return <div className="center-screen"><div className="row"><Logo size={26}/><span>Checking access…</span></div></div>
  if (!principal && setup) return <FirstRunSetup onDone={() => { setSetup(false); void check() }}/>
  if (!principal) return <Login error={error} onSignedIn={setPrincipal}/>
  return <SessionContext.Provider value={{principal, switchTenant, logout}}>{children}</SessionContext.Provider>
}

function Frame({children}: {children: ReactNode}) {
  return <main className="login">
    <section className="login-art" aria-hidden="true">
      <div className="row"><Logo/><b style={{fontSize: 16}}>Digital Twin</b></div>
      <div>
        <h2>Every customer gets an isolated digital twin of their infrastructure.</h2>
        <p>Install one small agent per machine and the twin builds itself — continuously updated, with candidate attack paths and sandboxed validation.</p>
        <ul>
          <li><Icon name="bolt"/>One copy-paste command per server, or a whole fleet at once</li>
          <li><Icon name="cube"/>Live 3D twin with attack-path replay</li>
          <li><Icon name="shieldCheck"/>Workspace-isolated data, events, sandboxes and audit</li>
        </ul>
      </div>
      <small className="muted">Candidate paths are investigation aids until validated in a twin.</small>
      <svg className="iso" width="420" height="360" viewBox="0 0 420 360">
        {[0, 1, 2].map(r => [0, 1, 2].map(c => {
          const x = 120 + c * 70 - r * 70, y = 100 + c * 40 + r * 40
          return <g key={`${r}${c}`} transform={`translate(${x} ${y})`}>
            <path d="M0 0l55 -32 55 32 -55 32z" fill={r === 2 && c === 2 ? '#ede9fe' : '#fff'} stroke="#c7d2fe"/>
            <path d="M0 0v14l55 32v-14zM110 0v14l-55 32v-14z" fill="#e0e7ff" stroke="#c7d2fe"/>
          </g>
        }))}
        <path d="M120 100 C 200 40, 260 120, 330 180" fill="none" stroke="#e11d48" strokeWidth="2.5" strokeDasharray="6 6"/>
      </svg>
    </section>
    <section className="login-form">{children}</section>
  </main>
}

function Login({error: initialError, onSignedIn}: {error: string; onSignedIn: (p: Principal) => void}) {
  const [mode, setMode] = useState<'password' | 'credential'>('password')
  const [username, setUsername] = useState(DEMO ? 'demo.analyst' : ''), [password, setPassword] = useState(DEMO ? 'demo-password-123' : '')
  const [token, setToken] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(initialError)
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      onSignedIn(await api.post<Principal>('/api/auth/login', mode === 'password' ? {username, password} : {token}))
    } catch (e) {
      setError(e instanceof ApiError ? (e.status === 401 ? (mode === 'password' ? 'Username or password is incorrect.' : 'Credential invalid or expired.')
        : e.status === 429 ? 'Too many attempts. Wait a minute before retrying.' : message(e)) : 'Sign-in failed.')
    } finally { setPassword(DEMO ? 'demo-password-123' : ''); setToken(''); setBusy(false) }
  }
  return <Frame><form onSubmit={submit}>
    <div><span className="eyebrow">Secure sign-in</span><h1>Welcome back</h1>
      <p className="muted" style={{marginTop: 6}}>{DEMO ? 'Demo mode: sign in to explore the platform console and three synthetic customers.' : 'Sign in with the account you created from your invite.'}</p></div>
    {mode === 'password' ? <>
      <label className="field">Username<input className="input" autoComplete="username" required value={username} onChange={e => setUsername(e.target.value)}/></label>
      <label className="field">Password<input className="input" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)}/></label>
    </> : <label className="field">Access credential
      <input className="input" type="password" autoComplete="off" required maxLength={256} value={token} onChange={e => setToken(e.target.value)}/></label>}
    {error && <div className="alert danger" role="alert"><Icon name="alert"/>{error}</div>}
    <button className="btn primary" style={{height: 42}} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    <button type="button" className="btn ghost sm" onClick={() => { setMode(mode === 'password' ? 'credential' : 'password'); setError('') }}>
      {mode === 'password' ? 'Use an issued access credential instead' : 'Use username and password'}</button>
    <p className="muted" style={{fontSize: 12}}><Icon name="lock" size={13}/> Sessions are HttpOnly, bound to one workspace and expire automatically.</p>
  </form></Frame>
}

function FirstRunSetup({onDone}: {onDone: () => void}) {
  const [code, setCode] = useState(''), [username, setUsername] = useState(''), [name, setName] = useState('')
  const [password, setPassword] = useState(''), [confirm, setConfirm] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('')
    if (password !== confirm) { setError('Passwords do not match.'); return }
    setBusy(true)
    try { await api.post('/api/setup', {code, username, password, display_name: name}); onDone() }
    catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  return <Frame><form onSubmit={submit}>
    <div><span className="eyebrow">First-run setup</span><h1>Create the platform admin</h1>
      <p className="muted" style={{marginTop: 6}}>This account creates customers and invites their administrators. Find the one-time setup code in the server log (look for “First-run setup required”).</p></div>
    <label className="field">Setup code<input className="input mono" required placeholder="xxxxxxxx-xxxxxxxx" value={code} onChange={e => setCode(e.target.value)}/></label>
    <label className="field">Your name<input className="input" value={name} maxLength={80} onChange={e => setName(e.target.value)}/></label>
    <label className="field">Username<input className="input" required pattern="[a-zA-Z0-9_.@\-]{3,64}" autoComplete="username" value={username} onChange={e => setUsername(e.target.value)}/></label>
    <label className="field">Password <span className="muted" style={{fontWeight: 400}}>at least 12 characters</span>
      <input className="input" type="password" required minLength={12} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)}/></label>
    <label className="field">Confirm password<input className="input" type="password" required minLength={12} autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)}/></label>
    {error && <div className="alert danger" role="alert"><Icon name="alert"/>{error}</div>}
    <button className="btn primary" style={{height: 42}} disabled={busy}>{busy ? 'Creating…' : 'Create platform admin'}</button>
  </form></Frame>
}

type InviteInfo = {tenant_id: string | null; tenant_name: string | null; role: string | null; platform_admin: boolean; expires_at: string}

function AcceptInvite({token, onDone}: {token: string; onDone: () => void}) {
  const [info, setInfo] = useState<InviteInfo | null>(null), [error, setError] = useState(''), [existing, setExisting] = useState(false)
  const [username, setUsername] = useState(''), [name, setName] = useState(''), [password, setPassword] = useState(''), [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false), [done, setDone] = useState(false)
  useEffect(() => { api.post<InviteInfo>('/api/invites/describe', {token}).then(setInfo).catch(e => setError(message(e))) }, [token])
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('')
    if (!existing && password !== confirm) { setError('Passwords do not match.'); return }
    setBusy(true)
    try {
      await api.post('/api/invites/accept', {token, username, password, display_name: name, existing})
      await api.post('/api/auth/login', {username, password, ...(info?.tenant_id ? {tenant: info.tenant_id} : {})})
      setDone(true); setTimeout(onDone, 600)
    } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  const target = info?.platform_admin ? 'the platform console' : info?.tenant_name ?? 'a workspace'
  return <Frame><form onSubmit={submit}>
    <div><span className="eyebrow">You're invited</span><h1>{info ? `Join ${target}` : 'Accept invite'}</h1>
      {info && <p className="muted" style={{marginTop: 6}}>{info.platform_admin ? 'You will be able to create and manage customers.' : `You will join as ${info.role}.`} This invite expires {new Date(info.expires_at).toLocaleString()}.</p>}</div>
    {!info && !error && <p className="muted">Checking invite…</p>}
    {info && <>
      <div className="segmented" role="group" aria-label="Account">
        <button type="button" className={!existing ? 'on' : ''} onClick={() => setExisting(false)}>Create an account</button>
        <button type="button" className={existing ? 'on' : ''} onClick={() => setExisting(true)}>I already have one</button>
      </div>
      {!existing && <label className="field">Your name<input className="input" value={name} maxLength={80} onChange={e => setName(e.target.value)}/></label>}
      <label className="field">Username<input className="input" required pattern="[a-zA-Z0-9_.@\-]{3,64}" autoComplete="username" value={username} onChange={e => setUsername(e.target.value)}/></label>
      <label className="field">Password {!existing && <span className="muted" style={{fontWeight: 400}}>at least 12 characters</span>}
        <input className="input" type="password" required minLength={existing ? 1 : 12} autoComplete={existing ? 'current-password' : 'new-password'} value={password} onChange={e => setPassword(e.target.value)}/></label>
      {!existing && <label className="field">Confirm password<input className="input" type="password" required minLength={12} autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)}/></label>}
    </>}
    {error && <div className="alert danger" role="alert"><Icon name="alert"/>{error}</div>}
    {done && <div className="alert info" role="status"><Icon name="check"/>Welcome aboard — opening your workspace…</div>}
    {info && <button className="btn primary" style={{height: 42}} disabled={busy || done}>{busy ? 'Joining…' : `Join ${target}`}</button>}
    <button type="button" className="btn ghost sm" onClick={onDone}>Back to sign in</button>
  </form></Frame>
}
