import {useMemo, useState} from 'react'
import {api, message} from '../api'
import {useSession} from '../auth'
import type {TwinData} from '../useTwinData'
import {hostName, serviceInfo} from '../useTwinData'
import {Icon} from './icons'

type Suggestion = {id: string; role: 'entry' | 'critical'; reason: string}
const LIVE = new Set(['OBSERVED_CONNECTION', 'INFERRED_REACHABILITY'])
const DATA_STORES = new Set(['postgresql', 'redis'])

/** Proposes entry and critical assets so attack paths appear without manual marking. */
export function suggestRoles(data: TwinData): Suggestion[] {
  const {nodes, edges} = data.topology
  const hosts = nodes.filter(n => n.labels.includes('Host'))
  const services = (id: string) => edges.filter(e => e.source === id && e.kind === 'HAS_SERVICE')
    .map(e => serviceInfo(nodes.find(n => n.id === e.target)?.properties.data_json).name)
  const inbound = (id: string) => edges.filter(e => e.target === id && LIVE.has(e.kind) && e.source !== id).length
  const outbound = (id: string) => edges.filter(e => e.source === id && LIVE.has(e.kind) && e.target !== id).length
  const result: Suggestion[] = []
  for (const h of hosts) {
    const kinds = services(h.id)
    if (!h.properties.entry && outbound(h.id) > 0 && inbound(h.id) === 0)
      result.push({id: h.id, role: 'entry', reason: kinds.includes('nginx') ? 'web-facing service with no inbound internal traffic' : 'perimeter host: only outbound connections'})
    if (!h.properties.critical && kinds.some(k => DATA_STORES.has(k)) && inbound(h.id) > 0)
      result.push({id: h.id, role: 'critical', reason: `stores data (${kinds.filter(k => DATA_STORES.has(k)).join(', ')})`})
  }
  return result
}

export function RoleSuggestions({data}: {data: TwinData}) {
  const {principal} = useSession()
  const suggestions = useMemo(() => suggestRoles(data), [data])
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(suggestions.map(s => s.id + s.role)))
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [hidden, setHidden] = useState(false)
  const hosts = data.topology.nodes.filter(n => n.labels.includes('Host'))
  const declared = hosts.some(h => h.properties.entry) && hosts.some(h => h.properties.critical)
  if (hidden || declared || suggestions.length === 0) return null
  async function apply() {
    setBusy(true); setError('')
    try {
      const picked = suggestions.filter(s => chosen.has(s.id + s.role))
      for (const id of new Set(picked.map(s => s.id))) {
        const node = hosts.find(h => h.id === id)!
        await api.put(`/api/assets/${encodeURIComponent(id)}/classification`, {
          entry: Boolean(node.properties.entry) || picked.some(s => s.id === id && s.role === 'entry'),
          critical: Boolean(node.properties.critical) || picked.some(s => s.id === id && s.role === 'critical')})
      }
      await data.refresh()
    } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  return <section className="card" aria-label="Suggested roles">
    <div className="card-head"><div><h2><Icon name="spark" size={15}/> Suggested entry points and crown jewels</h2>
      <p>Attack paths need at least one entry and one critical asset. We inferred these from your twin — review and apply.</p></div>
      <button className="icon-btn" aria-label="Dismiss" onClick={() => setHidden(true)}><Icon name="x" size={16}/></button></div>
    <div className="list">{suggestions.map(s => <label key={s.id + s.role} className="list-row">
      <input type="checkbox" checked={chosen.has(s.id + s.role)} disabled={principal.role === 'viewer'}
        onChange={e => { const next = new Set(chosen); if (e.target.checked) next.add(s.id + s.role); else next.delete(s.id + s.role); setChosen(next) }}/>
      <span className="meta"><b>{hostName(data.topology, s.id)}</b><small>{s.reason}</small></span>
      <span className={`chip ${s.role === 'entry' ? 'info' : 'violet'}`}>{s.role}</span></label>)}</div>
    <div className="card-body row between" style={{borderTop: '1px solid var(--border)'}}>
      {error ? <span className="alert danger" role="alert">{error}</span> : <small className="muted">Suggestions are heuristics; you can change roles any time in the inspector.</small>}
      {principal.role !== 'viewer' ? <button className="btn primary sm" disabled={busy || chosen.size === 0} onClick={() => void apply()}>{busy ? 'Applying…' : `Apply ${chosen.size} role${chosen.size === 1 ? '' : 's'}`}</button>
        : <small className="muted">An operator can apply these.</small>}
    </div>
  </section>
}
