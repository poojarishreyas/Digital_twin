import {useCallback, useEffect, useState, type FormEvent} from 'react'
import {api, message} from '../api'
import {tenantColor} from '../auth'
import type {Customer, InviteResult} from '../types'
import {Icon} from '../ui/icons'
import {CopyField, Modal} from '../ui/Modal'
import {ago} from '../useTwinData'

const inviteLink = (token: string) => `${location.origin}/#/invite/${token}`
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)

export function Platform() {
  const [customers, setCustomers] = useState<Customer[] | null>(null), [error, setError] = useState('')
  const [creating, setCreating] = useState(false), [invite, setInvite] = useState<{title: string; token: string} | null>(null)
  const [busy, setBusy] = useState('')
  const load = useCallback(async () => {
    try { setCustomers(await api.get<Customer[]>('/api/platform/tenants')); setError('') } catch (e) { setError(message(e)) }
  }, [])
  useEffect(() => { void load(); const timer = setInterval(load, 15000); return () => clearInterval(timer) }, [load])

  async function setStatus(customer: Customer, status: 'active' | 'suspended') {
    if (status === 'suspended' && !confirm(`Suspend ${customer.name}? Their users are signed out and their agents' telemetry is refused until you reactivate.`)) return
    setBusy(customer.id)
    try { await api.post(`/api/platform/tenants/${customer.id}/status`, {status}); await load() } catch (e) { setError(message(e)) } finally { setBusy('') }
  }
  async function newAdminInvite(customer: Customer) {
    setBusy(customer.id)
    try {
      const r = await api.post<InviteResult>(`/api/platform/tenants/${customer.id}/invites`, {role: 'admin', label: 'Administrator'})
      setInvite({title: `Admin invite for ${customer.name}`, token: r.invite_token})
    } catch (e) { setError(message(e)) } finally { setBusy('') }
  }
  async function platformAdminInvite() {
    try {
      const r = await api.post<InviteResult>('/api/platform/admins/invites', {label: 'Platform admin'})
      setInvite({title: 'Platform admin invite', token: r.invite_token})
    } catch (e) { setError(message(e)) }
  }

  const list = customers ?? []
  const totals = {customers: list.length, active: list.filter(c => c.status === 'active').length,
    reporting: list.reduce((n, c) => n + c.reporting_agents, 0), known: list.reduce((n, c) => n + c.known_agents, 0),
    runs: list.reduce((n, c) => n + c.active_runs, 0), invites: list.reduce((n, c) => n + c.pending_invites, 0)}

  return <>
    <div className="page-head">
      <div><span className="eyebrow"><Icon name="building" size={14}/>Platform console</span><h1>Customers</h1>
        <p>Create a customer and send its administrator an invite link. They install agents themselves and their twin builds automatically. You see health and usage only — each customer's topology, attack paths and findings stay private to them.</p></div>
      <div className="row"><button className="btn" onClick={() => void platformAdminInvite()}><Icon name="users"/>Invite platform admin</button>
        <button className="btn primary" onClick={() => setCreating(true)}><Icon name="plus"/>New customer</button></div>
    </div>
    {error && <div className="alert danger" role="alert"><Icon name="alert"/>{error}</div>}

    <section className="kpis" style={{gridTemplateColumns: 'repeat(4, minmax(0, 1fr))'}}>
      {[['Customers', totals.customers, `${totals.active} active`, 'building', 'accent'],
        ['Machines reporting', totals.reporting, `of ${totals.known} known`, 'server', totals.reporting ? 'ok' : ''],
        ['Simulations running', totals.runs, 'queued or in progress', 'flask', ''],
        ['Pending invites', totals.invites, 'not yet accepted', 'users', totals.invites ? 'warn' : '']].map(([label, value, note, icon, tone]) =>
        <article key={String(label)} className={`card kpi ${tone}`}><div className="kpi-top">{label}<span className="kpi-icon"><Icon name={String(icon)} size={16}/></span></div>
          <strong>{customers ? value : '—'}</strong><small>{note}</small></article>)}
    </section>

    <section className="card">
      <div className="card-head"><div><h2>All customers</h2><p>Health refreshes every 15 seconds</p></div>
        <button className="icon-btn" aria-label="Refresh" onClick={() => void load()}><Icon name="refresh" size={16}/></button></div>
      {!customers ? <div className="card-body stack">{[0, 1, 2].map(i => <div key={i} className="skeleton" style={{height: 44}}/>)}</div>
        : list.length === 0 ? <div className="empty" style={{padding: 56}}><Icon name="building"/><b>No customers yet</b><span>Create the first one — it takes a few seconds.</span>
          <button className="btn primary" style={{marginTop: 10}} onClick={() => setCreating(true)}><Icon name="plus"/>New customer</button></div>
        : <div className="table-wrap"><table className="table"><thead><tr><th>Customer</th><th>Status</th><th>Team</th><th>Machines</th><th>Last report</th><th>Simulations</th><th/></tr></thead>
          <tbody>{list.map(c => <tr key={c.id}>
            <td><div className="row" style={{flexWrap: 'nowrap'}}><span className="tenant-avatar" style={{background: tenantColor(c.id), width: 30, height: 30, fontSize: 11}}>{c.name.slice(0, 2).toUpperCase()}</span>
              <div><b>{c.name}</b><div className="mono muted" style={{fontSize: 11.5}}>{c.id}{c.managed_by === 'file' ? ' · managed by file' : ''}</div></div></div></td>
            <td><span className={`chip ${c.status === 'active' ? 'ok' : 'danger'}`}><span className="dot"/>{c.status}</span></td>
            <td>{c.members} {c.pending_invites > 0 && <span className="chip warn" style={{marginLeft: 4}}>{c.pending_invites} invited</span>}</td>
            <td><b>{c.reporting_agents}</b><span className="muted"> / {Math.max(c.known_agents, c.enrolled_agents)} reporting</span></td>
            <td>{c.last_report ? ago(c.last_report) : <span className="muted">never</span>}</td>
            <td>{c.runs}{c.active_runs > 0 && <span className="chip accent" style={{marginLeft: 4}}>{c.active_runs} active</span>}</td>
            <td><div className="row" style={{justifyContent: 'flex-end', flexWrap: 'nowrap'}}>
              <button className="btn sm" disabled={busy === c.id || c.status !== 'active'} onClick={() => void newAdminInvite(c)}>Invite admin</button>
              {c.managed_by === 'database' && (c.status === 'active'
                ? <button className="btn ghost sm" disabled={busy === c.id} onClick={() => void setStatus(c, 'suspended')}>Suspend</button>
                : <button className="btn ghost sm" disabled={busy === c.id} onClick={() => void setStatus(c, 'active')}>Reactivate</button>)}
            </div></td></tr>)}</tbody></table></div>}
    </section>

    {creating && <NewCustomer onClose={() => setCreating(false)} onCreated={async (name, token) => { setCreating(false); setInvite({title: `${name} is ready`, token}); await load() }}/>}
    {invite && <Modal title={invite.title} subtitle="Send this link privately. It works once and expires in 72 hours." onClose={() => setInvite(null)}>
      <div className="stack" style={{gap: 14}}>
        <CopyField label="Invite link" value={inviteLink(invite.token)} secret/>
        <ol className="steps">
          <li>The recipient opens the link and creates their account.</li>
          <li>In their workspace they open <b>Hosts → Add hosts</b> and paste one command on each server.</li>
          <li>Their machines appear in the 3D twin within seconds and stay live.</li>
        </ol>
        <p className="muted" style={{fontSize: 12}}>This link is shown only now. If it is lost, create a new invite from the customer list.</p>
        <button className="btn primary" onClick={() => setInvite(null)}>Done</button>
      </div>
    </Modal>}
  </>
}

function NewCustomer({onClose, onCreated}: {onClose: () => void; onCreated: (name: string, token: string) => void}) {
  const [name, setName] = useState(''), [id, setId] = useState(''), [edited, setEdited] = useState(false)
  const [label, setLabel] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const r = await api.post<{invite_token: string}>('/api/platform/tenants', {id, name, admin_label: label})
      onCreated(name, r.invite_token)
    } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  return <Modal title="New customer" subtitle="Creates an isolated workspace and an invite for its first administrator." onClose={onClose}>
    <form className="stack" style={{gap: 14}} onSubmit={submit}>
      <label className="field">Company name<input className="input" required maxLength={80} placeholder="Meridian Logistics" value={name}
        onChange={e => { setName(e.target.value); if (!edited) setId(slug(e.target.value)) }}/></label>
      <label className="field">Customer ID <span className="muted" style={{fontWeight: 400}}>lowercase, used in URLs and audit records</span>
        <input className="input mono" required pattern="[a-z0-9][a-z0-9\-]{0,31}" value={id} onChange={e => { setEdited(true); setId(e.target.value.toLowerCase()) }}/></label>
      <label className="field">First administrator <span className="muted" style={{fontWeight: 400}}>optional note, e.g. their name or email</span>
        <input className="input" maxLength={80} value={label} onChange={e => setLabel(e.target.value)}/></label>
      {error && <div className="alert danger" role="alert"><Icon name="alert"/>{error}</div>}
      <div className="row" style={{justifyContent: 'flex-end'}}><button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !id || !name}>{busy ? 'Creating…' : 'Create customer'}</button></div>
    </form>
  </Modal>
}
