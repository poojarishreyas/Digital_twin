import {Fragment, useEffect, useState} from 'react'
import {api, message} from '../api'
import {useSession} from '../auth'
import type {TwinData} from '../useTwinData'
import {ago, hostName, serviceInfo} from '../useTwinData'
import {Icon} from './icons'

export type PageProps = {data: TwinData; selected: string | null; onSelect: (id: string | null) => void; go: (page: string) => void}

const HIDDEN = new Set(['hardware_json', 'data_json', 'entry', 'critical', 'hostname', 'hash'])

export function Inspector({data, selected, onSelect, onFocus}: {data: TwinData; selected: string | null; onSelect: (id: string | null) => void; onFocus?: (id: string) => void}) {
  const {principal} = useSession()
  const node = data.topology.nodes.find(n => n.id === selected)
  if (!node) return <div className="empty"><Icon name="target"/><b>Select an asset</b><span>Click a platform or service module in the twin to inspect its evidence.</span></div>
  const isHost = node.labels.includes('Host'), service = node.properties.kind === 'service' ? serviceInfo(node.properties.data_json) : null
  const outgoing = data.topology.edges.filter(e => e.source === node.id && !e.kind.startsWith('HAS_'))
  const incoming = data.topology.edges.filter(e => e.target === node.id && !e.kind.startsWith('HAS_'))
  const services = data.topology.edges.filter(e => e.source === node.id && e.kind === 'HAS_SERVICE').map(e => data.topology.nodes.find(n => n.id === e.target)).filter(Boolean)
  const parent = data.topology.edges.find(e => e.target === node.id && e.kind.startsWith('HAS_'))?.source
  const agent = data.agents.find(a => a.agent_id === node.properties.agent_id)
  const title = service ? `${service.name}${service.version ? ' ' + service.version : ''}` : hostName(data.topology, node.id)

  return <div className="inspector stack" style={{gap: 14}}>
    <div className="row between" style={{alignItems: 'flex-start', flexWrap: 'nowrap'}}>
      <div style={{minWidth: 0}}>
        <div className="row" style={{gap: 6, marginBottom: 4}}>
          <span className="chip">{isHost ? 'Host' : service ? 'Service' : node.labels.filter(l => l !== 'Asset')[0] ?? 'Asset'}</span>
          {Boolean(node.properties.entry) && <span className="chip info">Entry</span>}
          {Boolean(node.properties.critical) && <span className="chip violet">Critical</span>}
          {agent && <span className={`chip ${agent.stale ? 'warn' : 'ok'}`}><span className="dot"/>{agent.stale ? 'Stale' : 'Reporting'}</span>}
        </div>
        <h3 style={{fontSize: 17}}>{title}</h3>
        <div className="id">{node.id}</div>
      </div>
      <button className="icon-btn" aria-label="Close inspector" onClick={() => onSelect(null)}><Icon name="x" size={16}/></button>
    </div>
    {onFocus && <button className="btn sm" onClick={() => onFocus(node.id)}><Icon name="target" size={15}/>Focus in 3D</button>}
    {principal.role !== 'viewer' && (isHost || !node.labels.includes('Component')) &&
      <Roles key={node.id} id={node.id} entry={Boolean(node.properties.entry)} critical={Boolean(node.properties.critical)} onSaved={data.refresh}/>}
    <dl>
      {parent && <><dt>Runs on</dt><dd><button className="btn ghost sm" style={{padding: 0, height: 'auto'}} onClick={() => onSelect(parent)}>{hostName(data.topology, parent)}</button></dd></>}
      {agent && <><dt>Last report</dt><dd>{ago(agent.last_seen)} · seq {agent.last_sequence}</dd></>}
      {Object.entries(node.properties).filter(([k]) => !HIDDEN.has(k)).slice(0, 12).map(([k, v]) =>
        <Fragment key={k}><dt>{k.replaceAll('_', ' ')}</dt><dd>{String(v)}</dd></Fragment>)}
    </dl>
    {services.length > 0 && <div><h4 style={{fontSize: 12.5, marginBottom: 8}}>Services · {services.length}</h4>
      <div className="row" style={{gap: 6}}>{services.map(s => { const info = serviceInfo(s!.properties.data_json)
        return <button key={s!.id} className="chip accent" style={{border: 0, cursor: 'pointer'}} onClick={() => onSelect(s!.id)}>{info.name} {info.version}</button> })}</div></div>}
    {(outgoing.length > 0 || incoming.length > 0) && <div><h4 style={{fontSize: 12.5, marginBottom: 8}}>Connectivity</h4>
      <div className="stack" style={{gap: 6}}>
        {[...outgoing.map(e => ({e, dir: '→', other: e.target})), ...incoming.map(e => ({e, dir: '←', other: e.source}))].slice(0, 10).map(({e, dir, other}, i) =>
          <button key={i} className="list-row" style={{padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)'}} onClick={() => onSelect(other)}>
            <span className="mono muted">{dir}</span><span className="meta"><b>{hostName(data.topology, other)}</b></span>
            <span className={`chip ${e.kind === 'INFERRED_REACHABILITY' ? 'warn' : e.kind === 'CONFIRMED_ATTACK_TRANSITION' ? 'danger' : 'ok'}`}>{e.kind === 'INFERRED_REACHABILITY' ? 'inferred' : e.kind === 'CONFIRMED_ATTACK_TRANSITION' ? 'confirmed' : 'observed'}</span>
          </button>)}
      </div></div>}
    {agent && agent.gaps.length > 0 && <div className="alert warn"><Icon name="alert"/><div><b>{agent.gaps.length} collection gap{agent.gaps.length > 1 ? 's' : ''}</b>
      {agent.gaps.slice(0, 4).map((g, i) => <div key={i} style={{fontSize: 12}}>{g.collector}.{g.field}: {g.reason.replaceAll('_', ' ')}</div>)}</div></div>}
  </div>
}

function Roles({id, entry: e0, critical: c0, onSaved}: {id: string; entry: boolean; critical: boolean; onSaved: () => Promise<void>}) {
  const [entry, setEntry] = useState(e0), [critical, setCritical] = useState(c0), [busy, setBusy] = useState(false), [note, setNote] = useState('')
  useEffect(() => { setEntry(e0); setCritical(c0) }, [e0, c0])
  const dirty = entry !== e0 || critical !== c0
  async function save() {
    setBusy(true); setNote('')
    try { await api.put(`/api/assets/${encodeURIComponent(id)}/classification`, {entry, critical}); await onSaved(); setNote('Saved — candidate paths recompute automatically.') }
    catch (e) { setNote(message(e)) } finally { setBusy(false) }
  }
  return <div className="roles">
    <label className="toggle"><span><b>Entry asset</b><small>Where an attacker could start</small></span>
      <span className="switch"><input type="checkbox" checked={entry} disabled={busy} onChange={e => setEntry(e.target.checked)}/><span/></span></label>
    <label className="toggle"><span><b>Critical asset</b><small>Crown-jewel target for path analysis</small></span>
      <span className="switch"><input type="checkbox" checked={critical} disabled={busy} onChange={e => setCritical(e.target.checked)}/><span/></span></label>
    {dirty && <button className="btn primary sm" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save roles'}</button>}
    {note && <small className="muted" role="status">{note}</small>}
  </div>
}
