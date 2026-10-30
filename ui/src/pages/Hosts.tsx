import {useCallback, useEffect, useRef, useState} from 'react'
import {api, message} from '../api'
import {useSession} from '../auth'
import type {EnrollmentToken, Host} from '../types'
import {Icon} from '../ui/icons'
import {CopyField, Modal} from '../ui/Modal'
import {ago, type TwinData} from '../useTwinData'

type Os = 'linux' | 'windows' | 'fleet'

function commands(token: string) {
  const origin = location.origin
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)
  const insecure = location.protocol === 'http:' && !local
  return {
    linux: `curl -fsSL ${origin}/agent/install.sh | sudo bash -s -- --url ${origin} --token ${token}${insecure ? ' --allow-http' : ''}`,
    windows: `& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing ${origin}/agent/install.ps1).Content)) -Url ${origin} -Token ${token}${insecure ? ' -AllowHttp' : ''}`,
    fleet: `#!/bin/bash\n# Cloud "user data" or any provisioning tool: every new server joins the twin at boot.\ncurl -fsSL ${origin}/agent/install.sh | bash -s -- --url ${origin} --token ${token}${insecure ? ' --allow-http' : ''}`,
    insecure,
  }
}

const status = (h: Host) => h.revoked_at ? {label: 'revoked', tone: 'danger'} : !h.last_seen ? {label: 'waiting for first report', tone: 'warn'}
  : Date.now() - new Date(h.last_seen).getTime() < 5 * 60000 ? {label: 'reporting', tone: 'ok'} : {label: 'stale', tone: 'warn'}

export function Hosts({data}: {data: TwinData}) {
  const {principal} = useSession()
  const admin = principal.role === 'admin'
  const [hosts, setHosts] = useState<Host[]>([]), [tokens, setTokens] = useState<EnrollmentToken[]>([]), [enabled, setEnabled] = useState(true)
  const [error, setError] = useState(''), [adding, setAdding] = useState(false)
  const load = useCallback(async () => {
    try {
      setHosts(await api.get<Host[]>('/api/hosts'))
      if (admin) { const t = await api.get<{enabled: boolean; tokens: EnrollmentToken[]}>('/api/enrollment/tokens'); setEnabled(t.enabled); setTokens(t.tokens) }
      setError('')
    } catch (e) { setError(message(e)) }
  }, [admin])
  useEffect(() => { void load(); const timer = setInterval(load, 10000); return () => clearInterval(timer) }, [load])

  async function revokeHost(h: Host) {
    if (!confirm(`Remove ${h.hostname || h.agent_id}? Its telemetry is refused immediately. To add it back, run the install command again with a new token.`)) return
    try { await api.post(`/api/hosts/${h.agent_id}/revoke`, {}); await load(); await data.refresh() } catch (e) { setError(message(e)) }
  }
  async function revokeToken(t: EnrollmentToken) {
    try { await api.post(`/api/enrollment/tokens/${t.id}/revoke`, {}); await load() } catch (e) { setError(message(e)) }
  }

  const enrolled = new Set(hosts.map(h => h.agent_id))
  const legacy = data.agents.filter(a => !enrolled.has(a.agent_id))
  const active = hosts.filter(h => !h.revoked_at)
  const reporting = active.filter(h => status(h).label === 'reporting').length

  return <>
    <div className="page-head">
      <div><span className="eyebrow"><Icon name="server" size={14}/>Hosts</span><h1>Machines in your twin</h1>
        <p>Each machine runs a small read-only agent that keeps your twin current. Add machines with one copy-paste command — or one command for your whole fleet.</p></div>
      {admin && <button className="btn primary" disabled={!enabled} onClick={() => setAdding(true)}><Icon name="plus"/>Add hosts</button>}
    </div>
    {error && <div className="alert danger" role="alert"><Icon name="alert"/>{error}</div>}
    {admin && !enabled && <div className="alert warn"><Icon name="alert"/><div><b>Agent enrollment is not configured on this server.</b> Ask your platform administrator to create the enrollment certificate authority (<code>deploy/pki/new-enrollment-ca</code>) and restart ingestion.</div></div>}

    <section className="card card-pad stat-inline">
      <div><b>{active.length + legacy.length}</b><span>machines</span></div>
      <div><b>{reporting + legacy.filter(a => !a.stale).length}</b><span>reporting now</span></div>
      <div><b>{active.filter(h => !h.last_seen).length}</b><span>waiting for first report</span></div>
      <div><b>{hosts.filter(h => h.revoked_at).length}</b><span>removed</span></div>
    </section>

    <section className="card">
      <div className="card-head"><div><h2>Machines</h2><p>Status updates every 10 seconds</p></div>
        <button className="icon-btn" aria-label="Refresh" onClick={() => void load()}><Icon name="refresh" size={16}/></button></div>
      {hosts.length + legacy.length === 0 ? <div className="empty" style={{padding: 56}}><Icon name="server"/><b>No machines yet</b>
          <span>{admin ? 'Click “Add hosts”, copy the command, and run it on a server. It appears here in seconds.' : 'An administrator can add machines to this workspace.'}</span>
          {admin && enabled && <button className="btn primary" style={{marginTop: 10}} onClick={() => setAdding(true)}><Icon name="plus"/>Add hosts</button>}</div>
        : <div className="table-wrap"><table className="table"><thead><tr><th>Machine</th><th>Status</th><th>Enrolled</th><th>Last report</th><th>Certificate</th><th/></tr></thead>
          <tbody>
            {hosts.map(h => { const s = status(h); return <tr key={h.agent_id} style={h.revoked_at ? {opacity: .55} : undefined}>
              <td><div className="row" style={{flexWrap: 'nowrap'}}><span className="os-badge"><Icon name="server" size={15}/></span>
                <div><b>{h.hostname || 'unnamed host'}</b><div className="mono muted" style={{fontSize: 11.5}}>{h.os || 'unknown OS'} · {h.agent_id.slice(0, 12)}</div></div></div></td>
              <td><span className={`chip ${s.tone}`}><span className="dot"/>{s.label}</span></td>
              <td>{ago(h.enrolled_at)}</td><td>{h.last_seen ? ago(h.last_seen) : '—'}</td>
              <td className="muted">{h.revoked_at ? `removed ${ago(h.revoked_at)}` : `valid until ${new Date(h.certificate_expires_at).toLocaleDateString()}`}</td>
              <td style={{textAlign: 'right'}}>{admin && !h.revoked_at && <button className="btn ghost sm" onClick={() => void revokeHost(h)}>Remove</button>}</td>
            </tr> })}
            {legacy.map(a => <tr key={a.agent_id}>
              <td><div className="row" style={{flexWrap: 'nowrap'}}><span className="os-badge"><Icon name="server" size={15}/></span>
                <div><b className="mono">{a.agent_id.slice(0, 12)}</b><div className="muted" style={{fontSize: 11.5}}>registered by an administrator file</div></div></div></td>
              <td><span className={`chip ${a.stale ? 'warn' : 'ok'}`}><span className="dot"/>{a.stale ? 'stale' : 'reporting'}</span></td>
              <td>—</td><td>{ago(a.last_seen)}</td><td className="muted">manual certificate</td><td/>
            </tr>)}
          </tbody></table></div>}
    </section>

    {admin && tokens.length > 0 && <section className="card">
      <div className="card-head"><div><h2>Install commands</h2><p>Each command works only for this workspace, for a limited time and number of machines</p></div></div>
      <div className="table-wrap"><table className="table"><thead><tr><th>Label</th><th>Machines</th><th>Expires</th><th>Created by</th><th>Status</th><th/></tr></thead>
        <tbody>{tokens.map(t => <tr key={t.id}>
          <td><b>{t.label || 'Untitled'}</b></td><td>{t.uses} / {t.max_uses}</td><td>{new Date(t.expires_at).toLocaleString()}</td><td>{t.created_by}</td>
          <td><span className={`chip ${t.usable ? 'ok' : ''}`}>{t.revoked ? 'revoked' : t.usable ? 'active' : t.uses >= t.max_uses ? 'used up' : 'expired'}</span></td>
          <td style={{textAlign: 'right'}}>{t.usable && <button className="btn ghost sm" onClick={() => void revokeToken(t)}>Revoke</button>}</td></tr>)}</tbody></table></div>
    </section>}

    {adding && <AddHosts known={hosts.length} onClose={() => { setAdding(false); void load() }} onJoined={() => { void load(); void data.refresh() }}/>}
  </>
}

function AddHosts({known, onClose, onJoined}: {known: number; onClose: () => void; onJoined: () => void}) {
  const [label, setLabel] = useState(''), [uses, setUses] = useState(1), [minutes, setMinutes] = useState(60)
  const [token, setToken] = useState<string | null>(null), [os, setOs] = useState<Os>('linux'), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [joined, setJoined] = useState<Host[]>([])
  const baseline = useRef(known)
  async function generate() {
    setBusy(true); setError('')
    try { setToken((await api.post<{token: string}>('/api/enrollment/tokens', {label, minutes, max_uses: uses})).token) }
    catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  useEffect(() => {
    if (!token) return
    const timer = setInterval(async () => {
      try {
        const hosts = await api.get<Host[]>('/api/hosts')
        if (hosts.length > baseline.current) { setJoined(hosts.slice(0, hosts.length - baseline.current)); onJoined() }
      } catch { /* keep polling */ }
    }, 3000)
    return () => clearInterval(timer)
  }, [token, onJoined])
  const cmd = token ? commands(token) : null
  return <Modal title="Add hosts" subtitle="Run one command on each machine. It installs the read-only agent and joins this workspace." onClose={onClose} width={720}>
    {!token ? <div className="stack" style={{gap: 14}}>
      <label className="field">Label <span className="muted" style={{fontWeight: 400}}>optional, e.g. “AWS production”</span>
        <input className="input" maxLength={80} value={label} onChange={e => setLabel(e.target.value)}/></label>
      <div className="row" style={{gap: 12, flexWrap: 'nowrap'}}>
        <label className="field" style={{flex: 1}}>How many machines may use this command?
          <select className="select" value={uses} onChange={e => setUses(Number(e.target.value))}>
            <option value={1}>One machine</option><option value={10}>Up to 10</option><option value={100}>Up to 100</option><option value={1000}>Up to 1,000 (fleet)</option></select></label>
        <label className="field" style={{flex: 1}}>Valid for
          <select className="select" value={minutes} onChange={e => setMinutes(Number(e.target.value))}>
            <option value={60}>1 hour</option><option value={1440}>24 hours</option><option value={10080}>7 days</option></select></label>
      </div>
      <div className="alert info"><Icon name="lock"/><div>The command contains a short-lived token tied to this workspace only. Each machine generates its own key, which never leaves it, and gets its own certificate. Remove a machine any time to cut it off.</div></div>
      {error && <div className="alert danger" role="alert"><Icon name="alert"/>{error}</div>}
      <div className="row" style={{justifyContent: 'flex-end'}}><button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={() => void generate()}><Icon name="bolt" size={15}/>{busy ? 'Generating…' : 'Generate install command'}</button></div>
    </div> : <div className="stack" style={{gap: 14}}>
      <div className="tabs" role="tablist">{([['linux', 'Linux'], ['windows', 'Windows'], ['fleet', 'Whole fleet']] as [Os, string][]).map(([key, text]) =>
        <button key={key} role="tab" aria-selected={os === key} className={os === key ? 'on' : ''} onClick={() => setOs(key)}>{text}</button>)}</div>
      {os === 'linux' && <ol className="steps">
        <li>Open a terminal on the server (for AWS: EC2 → select instance → <b>Connect</b>).</li>
        <li><CopyField label="Paste and run" value={cmd!.linux}/></li>
        <li>Wait a few seconds — the machine appears below and in your 3D twin.</li></ol>}
      {os === 'windows' && <ol className="steps">
        <li>Open <b>PowerShell as Administrator</b> on the machine.</li>
        <li><CopyField label="Paste and run" value={cmd!.windows}/></li>
        <li>Wait a few seconds — the machine appears below and in your 3D twin.</li></ol>}
      {os === 'fleet' && <ol className="steps">
        <li>Paste this into your cloud server template's <b>user data</b> (AWS Launch Template, Azure custom data, GCP startup script) or run it through Ansible, Intune or SCCM.</li>
        <li><CopyField label="Provisioning script" value={cmd!.fleet} multiline/></li>
        <li>Every machine that runs it joins automatically, up to the limit you chose ({uses}).</li></ol>}
      {cmd!.insecure && <div className="alert warn"><Icon name="alert"/>This platform is served over plain HTTP, so the command allows it. Use HTTPS outside an isolated lab.</div>}
      <div className={`alert ${joined.length ? 'info' : ''}`} style={joined.length ? undefined : {border: '1px dashed var(--border-strong)'}} role="status">
        <Icon name={joined.length ? 'check' : 'clock'}/>{joined.length ? <div><b>{joined.length} machine{joined.length > 1 ? 's' : ''} joined:</b> {joined.map(h => h.hostname || h.agent_id.slice(0, 8)).join(', ')}</div>
          : <span className="muted">Waiting for the first machine to join…</span>}</div>
      <p className="muted" style={{fontSize: 12}}>This command is shown only now. Close this window when you're done; you can generate another at any time.</p>
      <div className="row" style={{justifyContent: 'flex-end'}}><button className="btn primary" onClick={onClose}>Done</button></div>
    </div>}
  </Modal>
}
