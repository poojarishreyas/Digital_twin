import {useCallback, useEffect, useState} from 'react'
import {api, message} from '../api'
import {useSession} from '../auth'
import type {AuditRow} from '../types'
import {Icon} from '../ui/icons'

export function Audit() {
  const {principal} = useSession()
  const [rows, setRows] = useState<AuditRow[]>([]), [error, setError] = useState(''), [stage, setStage] = useState('all'), [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    setLoading(true)
    try { setRows(await api.get<AuditRow[]>('/api/admin/audit?limit=200')); setError('') } catch (e) { setError(message(e)) } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])
  const shown = rows.filter(r => stage === 'all' || r.stage === stage)
  const denied = rows.filter(r => r.stage === 'denied').length

  return <>
    <div className="page-head">
      <div><span className="eyebrow"><Icon name="shield" size={14}/>Governance</span><h1>Access audit</h1>
        <p>Intent and outcome records for every request in <b>{principal.tenant}</b>. Request bodies, query strings and credentials are never recorded; other workspaces' records are not visible here.</p></div>
      <div className="row">
        <div className="segmented" role="group" aria-label="Filter by stage">{['all', 'intent', 'outcome', 'denied'].map(s =>
          <button key={s} className={stage === s ? 'on' : ''} onClick={() => setStage(s)}>{s}{s === 'denied' && denied ? ` ${denied}` : ''}</button>)}</div>
        <button className="btn" onClick={() => void load()}><Icon name="refresh" size={16}/>Refresh</button>
      </div>
    </div>
    {error && <div className="alert danger" role="alert"><Icon name="alert"/>{error}</div>}
    <section className="card">
      {loading && rows.length === 0 ? <div className="card-body stack">{[0, 1, 2, 3, 4].map(i => <div key={i} className="skeleton" style={{height: 30}}/>)}</div>
        : shown.length === 0 ? <div className="empty"><Icon name="shield"/><b>No records</b></div> :
        <div className="table-wrap"><table className="table"><thead><tr><th>Time</th><th>Actor</th><th>Role</th><th>Action</th><th>Stage</th><th>Status</th><th>Request ID</th></tr></thead>
          <tbody>{shown.map(r => <tr key={String(r.id)}>
            <td>{new Date(r.recorded_at).toLocaleString()}</td><td><b>{r.actor}</b></td><td>{r.role}</td><td className="mono">{r.action}</td>
            <td><span className={`chip ${r.stage === 'denied' ? 'danger' : r.stage === 'outcome' ? 'ok' : 'info'}`}>{r.stage}</span></td>
            <td className="mono">{r.status ?? '—'}</td><td className="mono muted" style={{fontSize: 11.5}}>{r.request_id}</td></tr>)}</tbody></table></div>}
    </section>
  </>
}
