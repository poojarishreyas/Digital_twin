import {useCallback, useEffect, useState} from 'react'
import {api, message} from '../api'
import {useSession} from '../auth'
import type {InviteResult, PendingInvite, Role, TeamMember} from '../types'
import {Icon} from '../ui/icons'
import {CopyField, Modal} from '../ui/Modal'
import {ago} from '../useTwinData'

const ROLE_HELP: Record<Role, string> = {viewer: 'See the twin, paths and evidence', operator: 'Also mark assets and run simulations', admin: 'Also manage hosts and the team'}

export function Team() {
  const {principal} = useSession()
  const [members, setMembers] = useState<TeamMember[]>([]), [invites, setInvites] = useState<PendingInvite[]>([])
  const [error, setError] = useState(''), [inviting, setInviting] = useState(false), [link, setLink] = useState<string | null>(null)
  const load = useCallback(async () => {
    try { const t = await api.get<{members: TeamMember[]; invites: PendingInvite[]}>('/api/team'); setMembers(t.members); setInvites(t.invites); setError('') }
    catch (e) { setError(message(e)) }
  }, [])
  useEffect(() => { void load() }, [load])

  async function changeRole(m: TeamMember, role: Role) {
    try { await api.put(`/api/team/members/${encodeURIComponent(m.id)}`, {role}); await load() } catch (e) { setError(message(e)) }
  }
  async function remove(m: TeamMember) {
    if (!confirm(`Remove ${m.display_name || m.id} from this workspace? They are signed out of it immediately.`)) return
    try { await api.del(`/api/team/members/${encodeURIComponent(m.id)}`); await load() } catch (e) { setError(message(e)) }
  }
  async function revoke(i: PendingInvite) {
    try { await api.del(`/api/team/invites/${i.id}`); await load() } catch (e) { setError(message(e)) }
  }

  return <>
    <div className="page-head">
      <div><span className="eyebrow"><Icon name="users" size={14}/>Team</span><h1>People in this workspace</h1>
        <p>Invite colleagues with a link. Roles apply only to this workspace — someone can be an admin here and a viewer elsewhere.</p></div>
      <button className="btn primary" onClick={() => setInviting(true)}><Icon name="plus"/>Invite people</button>
    </div>
    {error && <div className="alert danger" role="alert"><Icon name="alert"/>{error}</div>}
    <section className="card">
      <div className="card-head"><div><h2>Members · {members.length}</h2><p>Changes take effect on their next request</p></div></div>
      <div className="table-wrap"><table className="table"><thead><tr><th>Person</th><th>Role</th><th>Last sign-in</th><th/></tr></thead>
        <tbody>{members.map(m => <tr key={m.id}>
          <td><div className="row" style={{flexWrap: 'nowrap'}}><span className="avatar">{(m.display_name || m.id).slice(0, 2).toUpperCase()}</span>
            <div><b>{m.display_name || m.id}</b>{m.id === principal.id && <span className="chip accent" style={{marginLeft: 6}}>you</span>}
              <div className="mono muted" style={{fontSize: 11.5}}>{m.id}{m.managed_by === 'file' ? ' · managed by administrator file' : ''}</div></div></div></td>
          <td>{m.managed_by === 'database'
            ? <select className="select" aria-label={`Role for ${m.id}`} value={m.role} onChange={e => void changeRole(m, e.target.value as Role)}>
                {(['viewer', 'operator', 'admin'] as Role[]).map(r => <option key={r} value={r}>{r}</option>)}</select>
            : <span className="chip">{m.role}</span>}</td>
          <td>{m.last_login ? ago(m.last_login) : <span className="muted">never</span>}</td>
          <td style={{textAlign: 'right'}}>{m.managed_by === 'database' && <button className="btn ghost sm" onClick={() => void remove(m)}>Remove</button>}</td>
        </tr>)}</tbody></table></div>
    </section>
    {invites.length > 0 && <section className="card">
      <div className="card-head"><div><h2>Pending invites · {invites.length}</h2><p>Links that have not been used yet</p></div></div>
      <div className="list">{invites.map(i => <div key={i.id} className="list-row" style={{cursor: 'default'}}>
        <span className="os-badge"><Icon name="users" size={15}/></span>
        <span className="meta"><b>{i.label || 'Invite'} · {i.role}</b><small>sent by {i.created_by} · expires {new Date(i.expires_at).toLocaleString()}</small></span>
        <button className="btn ghost sm" onClick={() => void revoke(i)}>Revoke</button></div>)}</div>
    </section>}
    {inviting && <InviteModal onClose={() => setInviting(false)} onCreated={token => { setInviting(false); setLink(`${location.origin}/#/invite/${token}`); void load() }}/>}
    {link && <Modal title="Invite link ready" subtitle="Send it privately. It works once and expires in 72 hours." onClose={() => setLink(null)}>
      <div className="stack" style={{gap: 14}}><CopyField label="Invite link" value={link} secret/>
        <button className="btn primary" onClick={() => setLink(null)}>Done</button></div></Modal>}
  </>
}

function InviteModal({onClose, onCreated}: {onClose: () => void; onCreated: (token: string) => void}) {
  const [role, setRole] = useState<Role>('viewer'), [label, setLabel] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function create() {
    setBusy(true); setError('')
    try { onCreated((await api.post<InviteResult>('/api/team/invites', {role, label})).invite_token) } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  return <Modal title="Invite people" onClose={onClose}>
    <div className="stack" style={{gap: 14}}>
      <label className="field">Who is it for? <span className="muted" style={{fontWeight: 400}}>optional note</span>
        <input className="input" maxLength={80} placeholder="e.g. Priya from IT" value={label} onChange={e => setLabel(e.target.value)}/></label>
      <div className="stack" style={{gap: 8}}>{(['viewer', 'operator', 'admin'] as Role[]).map(r =>
        <label key={r} className="list-row" style={{border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px'}}>
          <input type="radio" name="role" checked={role === r} onChange={() => setRole(r)}/>
          <span className="meta"><b style={{textTransform: 'capitalize'}}>{r}</b><small>{ROLE_HELP[r]}</small></span></label>)}</div>
      {error && <div className="alert danger" role="alert"><Icon name="alert"/>{error}</div>}
      <div className="row" style={{justifyContent: 'flex-end'}}><button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={() => void create()}>{busy ? 'Creating…' : 'Create invite link'}</button></div>
    </div>
  </Modal>
}
