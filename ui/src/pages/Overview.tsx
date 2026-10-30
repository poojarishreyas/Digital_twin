import {useEffect, useRef, useState} from 'react'
import {api} from '../api'
import {useSession} from '../auth'
import type {PathReport, Run} from '../types'
import {Twin3D, type TwinHandle} from '../twin/Twin3D'
import {Icon} from '../ui/icons'
import {Inspector, type PageProps} from '../ui/Inspector'
import {RoleSuggestions} from '../ui/RoleSuggestions'
import {ago, hostName} from '../useTwinData'

export function Overview({data, selected, onSelect, go}: PageProps) {
  const {principal} = useSession()
  const twin = useRef<TwinHandle>(null)
  const [paths, setPaths] = useState<PathReport | null>(null), [runs, setRuns] = useState<Run[]>([])
  const [replay, setReplay] = useState<{hop: number; outcome?: string} | null>(null)
  useEffect(() => {
    api.get<PathReport>('/api/paths?max_depth=4').then(setPaths).catch(() => setPaths(null))
    api.get<Run[]>('/api/emulation/runs?limit=5').then(setRuns).catch(() => setRuns([]))
  }, [data.updated])

  const {topology, agents} = data
  const hosts = topology.nodes.filter(n => n.labels.includes('Host')).length
  const services = topology.nodes.filter(n => n.properties.kind === 'service').length
  const stale = agents.filter(a => a.stale).length, gaps = agents.reduce((n, a) => n + a.gaps.length, 0)
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
    {label: 'Services', value: services, note: 'nginx · postgres · redis · ssh', icon: 'layers', tone: ''},
    {label: 'Candidate paths', value: paths?.universe.path_count ?? '—', note: 'entry → critical, unvalidated', icon: 'route', tone: (paths?.universe.path_count ?? 0) > 0 ? 'danger' : 'ok'},
    {label: 'Critical assets', value: paths?.universe.critical.length ?? '—', note: `${paths?.universe.entries.length ?? 0} entry points`, icon: 'target', tone: ''},
    {label: 'Stale agents', value: stale, note: stale ? 'evidence may be outdated' : 'all reporting', icon: 'clock', tone: stale ? 'warn' : 'ok'},
    {label: 'Collection gaps', value: gaps, note: gaps ? 'permission or support gaps' : 'complete telemetry', icon: 'alert', tone: gaps ? 'warn' : 'ok'},
  ]

  return <>
    <div className="page-head">
      <div><span className="eyebrow"><Icon name="pulse" size={14}/>{tenantName}</span><h1>Security posture overview</h1>
        <p>Live inventory and topology from this workspace's agents, with candidate attack paths from declared entry points to crown-jewel assets.</p></div>
      <div className="row"><button className="btn" onClick={() => go('paths')}><Icon name="route"/>Investigate paths</button>
        <button className="btn primary" onClick={() => go('simulations')}><Icon name="flask"/>Run simulation</button></div>
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

    <div className="grid-2">
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
      <section className="card" aria-label="Recent simulations">
        <div className="card-head"><div><h2>Recent simulations</h2><p>Sandboxed twin validation runs</p></div>
          <button className="btn ghost sm" onClick={() => go('simulations')}>View all</button></div>
        {runs.length === 0 ? <div className="empty"><Icon name="flask"/><b>No simulations yet</b><span>Plan one from the Simulations page.</span></div> :
          <div className="list">{runs.slice(0, 5).map(r => <button key={r.id} className="list-row" onClick={() => go('simulations')}>
            <span className="os-badge"><Icon name="flask" size={16}/></span>
            <span className="meta"><b className="mono">{r.id.slice(0, 8)}</b><small>{ago(r.created_at)} · cleanup {r.cleanup_status}</small></span>
            <span className={`chip ${r.status === 'completed' ? 'ok' : r.status === 'failed' ? 'danger' : 'accent'}`}><span className="dot"/>{r.status}</span>
          </button>)}</div>}
      </section>
    </div>
  </>
}
