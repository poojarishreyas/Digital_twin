import {useEffect, useRef, useState} from 'react'
import {api} from '../api'
import {useSession} from '../auth'
import type {PathReport} from '../types'
import {Twin3D, type TwinHandle} from '../twin/Twin3D'
import {Icon} from '../ui/icons'
import {Inspector, type PageProps} from '../ui/Inspector'
import {RoleSuggestions} from '../ui/RoleSuggestions'
import {ago, hostName} from '../useTwinData'

export function Overview({data, selected, onSelect, go}: PageProps) {
  const {principal} = useSession()
  const twin = useRef<TwinHandle>(null)
  const [paths, setPaths] = useState<PathReport | null>(null)
  const [replay, setReplay] = useState<{hop: number; outcome?: string} | null>(null)
  useEffect(() => {
    api.get<PathReport>('/api/paths?max_depth=4').then(setPaths).catch(() => setPaths(null))
  }, [data.updated])

  const {topology, agents} = data
  const hosts = topology.nodes.filter(n => n.labels.includes('Host')).length
  const serviceNodes = topology.nodes.filter(n => n.properties.kind === 'service')
  const serviceNames = [...new Set(serviceNodes.map(n => {
    try { return String(JSON.parse(String(n.properties.data_json ?? '{}')).name ?? '') } catch { return '' }
  }).filter(Boolean))]
  const top = paths?.assessments[0]
  const tenantName = principal.tenants.find(t => t.id === principal.tenant)?.name ?? principal.tenant

  async function replayTop() {
    if (!top) return
    setReplay({hop: 0})
    const outcome = await twin.current!.playAttack(top.nodes, null, hop => setReplay({hop}))
    if (outcome !== 'cancelled') setReplay({hop: top.nodes.length - 1, outcome})
  }
  function stop() { twin.current?.stop(); setReplay(null) }

  const kpis = [
    {label: 'Hosts in twin', value: hosts, note: `${agents.length} enrolled agents`, icon: 'server', tone: 'accent'},
    {label: 'Services', value: serviceNodes.length, note: serviceNames.slice(0, 4).join(' · ') || 'none discovered yet', icon: 'layers', tone: ''},
    {label: 'Candidate paths', value: paths?.universe.path_count ?? '—', note: 'entry → critical, unvalidated', icon: 'route', tone: (paths?.universe.path_count ?? 0) > 0 ? 'danger' : 'ok'},
    {label: 'Critical assets', value: paths?.universe.critical.length ?? '—', note: `${paths?.universe.entries.length ?? 0} entry points`, icon: 'target', tone: ''},
  ]

  return <>
    <div className="page-head">
      <div><span className="eyebrow"><Icon name="pulse" size={14}/>{tenantName}</span><h1>Security posture overview</h1>
        <p>Live map of your machines and the paths an attacker could take to critical assets.</p></div>
      <div className="row"><button className="btn primary" onClick={() => go('paths')}><Icon name="route"/>Investigate paths</button></div>
    </div>

    <section className="kpis" aria-label="Key indicators">
      {kpis.map(k => <article key={k.label} className={`card kpi ${k.tone}`}>
        <div className="kpi-top">{k.label}<span className="kpi-icon"><Icon name={k.icon} size={16}/></span></div>
        <strong>{data.loading ? <span className="skeleton" style={{display: 'block', width: 54, height: 28}}/> : k.value}</strong><small>{k.note}</small>
      </article>)}
    </section>

    <RoleSuggestions data={data}/>

    <div className="grid-2">
      <Twin3D ref={twin} topology={topology} selected={selected} onSelect={onSelect} height={560}>
        <div className="twin-hud">
          {top && !replay && <div className="hud-card">
            <h3><Icon name="bolt" size={15}/>Highest-priority candidate</h3>
            <p>{top.nodes.map(n => hostName(topology, n)).join(' → ')} · {top.hop_count} hops</p>
            <div className="row" style={{marginTop: 10}}><button className="btn danger sm" onClick={() => void replayTop()}><Icon name="play" size={14}/>Replay attack path</button>
              <span className="chip warn">unvalidated</span></div>
          </div>}
          {replay && top && <div className="hud-card">
            <h3><Icon name="route" size={15}/>Replaying candidate path</h3>
            <div className="hops">{top.nodes.map((n, i) => <span key={n} className={`hop ${i < replay.hop ? 'hit' : i === replay.hop ? (replay.outcome ? 'hit' : 'now') : ''}`}>{hostName(topology, n)}</span>)}</div>
            <div className="row" style={{marginTop: 10}}><button className="btn sm" onClick={stop}><Icon name="stop" size={13}/>Stop</button>
              <button className="btn ghost sm" onClick={() => go('paths')}>Open in Attack paths</button></div>
          </div>}
          {replay?.outcome === 'reached' && <div className="outcome reached"><Icon name="alert"/><div>Critical asset reachable on this candidate route<small>Visual replay of telemetry — not a validated exploit.</small></div></div>}
        </div>
      </Twin3D>
      <section className="card card-pad" style={{minHeight: 560}} aria-label="Asset inspector">
        <Inspector data={data} selected={selected} onSelect={onSelect} onFocus={id => twin.current?.focus(id)}/>
      </section>
    </div>

    <section className="card" aria-label="Agent health">
        <div className="card-head"><div><h2>Agent health</h2><p>Telemetry freshness and collection completeness for this workspace</p></div>
          <span className="chip">{agents.length} agents</span></div>
        {agents.length === 0 ? <div className="empty"><Icon name="server"/><b>No agents enrolled</b><span>Register an agent certificate to this tenant to start discovery.</span></div> :
          <div className="table-wrap"><table className="table"><thead><tr><th>Host</th><th>Status</th><th>Sequence</th><th>Last report</th><th>Gaps</th></tr></thead>
            <tbody>{agents.map(a => <tr key={a.agent_id} className="clickable" onClick={() => onSelect(a.agent_id)}>
              <td><b>{hostName(topology, a.agent_id)}</b><div className="mono muted">{a.agent_id.slice(0, 14)}</div></td>
              <td><span className={`chip ${a.stale ? 'warn' : a.needs_full ? 'info' : 'ok'}`}><span className="dot"/>{a.stale ? 'Stale' : a.needs_full ? 'Reconciling' : 'Current'}</span></td>
              <td className="mono">{a.last_sequence}</td><td>{ago(a.last_seen)}</td>
              <td>{a.gaps.length ? <span className="chip warn">{a.gaps.length}</span> : <span className="muted">—</span>}</td></tr>)}</tbody></table></div>}
      </section>
  </>
}
