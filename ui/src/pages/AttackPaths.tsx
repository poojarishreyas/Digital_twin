import {useEffect, useRef, useState} from 'react'
import {api, message} from '../api'
import type {Assessment, PathReport} from '../types'
import {Twin3D, type TwinHandle} from '../twin/Twin3D'
import {Icon} from '../ui/icons'
import type {PageProps} from '../ui/Inspector'
import {ago, hostName} from '../useTwinData'

type Playback = {pathId: string; hop: number; outcome?: 'reached' | 'blocked'}
type Sweep = {done: number; total: number; reached: number; blocked: number; running: boolean}
const readable = (v: string) => v.toLowerCase().replaceAll('_', ' ')

export function AttackPaths({data, selected, onSelect}: PageProps) {
  const twin = useRef<TwinHandle>(null)
  const [depth, setDepth] = useState(4), [shield, setShield] = useState(''), [speed, setSpeed] = useState(1)
  const [report, setReport] = useState<PathReport | null>(null), [error, setError] = useState('')
  const [active, setActive] = useState<string | null>(null), [play, setPlay] = useState<Playback | null>(null), [sweep, setSweep] = useState<Sweep | null>(null)
  const cancelled = useRef(false)
  const {topology} = data

  useEffect(() => {
    let live = true
    const query = new URLSearchParams({max_depth: String(depth)})
    if (shield) query.set('isolated_asset', shield)
    api.get<PathReport>(`/api/paths?${query}`).then(r => { if (live) { setReport(r); setError(''); setActive(a => a && r.assessments.some(p => p.id === a) ? a : r.assessments[0]?.id ?? null) } })
      .catch(e => live && setError(message(e)))
    return () => { live = false }
  }, [depth, shield, data.updated])
  useEffect(() => { twin.current?.setSpeed(speed) }, [speed])

  const path = report?.assessments.find(p => p.id === active) ?? null
  const name = (id: string) => hostName(topology, id)

  async function replay(target: Assessment) {
    cancelled.current = false
    setSweep(null); setActive(target.id); setPlay({pathId: target.id, hop: 0})
    const outcome = await twin.current!.playAttack(target.nodes, shield || null, hop => setPlay({pathId: target.id, hop}))
    if (outcome !== 'cancelled') setPlay(p => p && {...p, outcome})
  }
  async function sweepAll() {
    if (!report) return
    cancelled.current = false
    const routes = report.assessments.slice(0, 15)
    const state: Sweep = {done: 0, total: routes.length, reached: 0, blocked: 0, running: true}
    setSweep({...state})
    twin.current!.setSpeed(Math.max(speed, 2.5))
    for (const route of routes) {
      if (cancelled.current) break
      setActive(route.id); setPlay({pathId: route.id, hop: 0})
      const outcome = await twin.current!.playAttack(route.nodes, shield || null, hop => setPlay({pathId: route.id, hop}))
      if (outcome === 'cancelled') break
      state.done++; state[outcome]++
      setSweep({...state})
      await new Promise(r => setTimeout(r, 450))
    }
    twin.current?.setSpeed(speed)
    setSweep({...state, running: false})
  }
  function stop() { cancelled.current = true; twin.current?.stop(); setPlay(null); setSweep(s => s && {...s, running: false}) }

  const hopClass = (route: Assessment, i: number) => {
    const isShield = shield && route.nodes[i] === shield
    const base = i === 0 ? 'entry' : i === route.nodes.length - 1 ? 'critical' : ''
    if (!play || play.pathId !== route.id) return isShield ? 'shield' : base
    if (isShield && play.outcome === 'blocked') return 'shield'
    if (i < play.hop || (play.outcome === 'reached' && i <= play.hop)) return 'hit'
    if (i === play.hop && !play.outcome) return 'now'
    return isShield ? 'shield' : base
  }

  return <>
    <div className="page-head">
      <div><span className="eyebrow"><Icon name="route" size={14}/>Attack path analysis</span><h1>Candidate attack paths</h1>
        <p>Directed routes from entry assets to critical assets over observed and inferred connectivity. Replays animate telemetry-derived candidates — every route stays <b>unvalidated</b> until a sandbox test confirms each hop.</p></div>
      <div className="row">
        <label className="row" style={{gap: 8, fontSize: 12.5, color: 'var(--muted)'}}>Hop limit
          <div className="segmented" role="group" aria-label="Hop limit">{[2, 3, 4, 6, 8].map(n => <button key={n} className={depth === n ? 'on' : ''} onClick={() => setDepth(n)}>{n}</button>)}</div></label>
        <label className="row" style={{gap: 8, fontSize: 12.5, color: 'var(--muted)'}}>Speed
          <div className="segmented" role="group" aria-label="Replay speed">{[0.5, 1, 2].map(n => <button key={n} className={speed === n ? 'on' : ''} onClick={() => setSpeed(n)}>{n}×</button>)}</div></label>
      </div>
    </div>
    {error && <div className="alert danger" role="alert"><Icon name="alert"/>{error}</div>}
    {report?.warnings.map(w => <div key={w} className="alert warn"><Icon name="alert"/>{w}</div>)}

    <div className="split">
      <div className="stack">
        <section className="card" aria-label="Isolation what-if">
          <div className="card-head"><div><h2>Isolation what-if</h2><p>Shield one shared asset and see which routes it interrupts</p></div><Icon name="shield"/></div>
          <div className="card-body stack" style={{gap: 12}}>
            <select className="select" aria-label="Asset to isolate" value={shield} onChange={e => { stop(); setShield(e.target.value) }}>
              <option value="">No isolation applied</option>
              {report?.review_points.map(p => <option key={p.asset_id} value={p.asset_id}>{p.label} — on {p.path_count} routes</option>)}
            </select>
            {report?.isolation_preview && <div className="alert info"><Icon name="shieldCheck"/><div>
              <b>{report.isolation_preview.affected_count} of {report.isolation_preview.affected_count + report.isolation_preview.remaining_count} routes interrupted</b>
              <div style={{fontSize: 12}}>{report.isolation_preview.remaining_count} would remain. {report.isolation_preview.limitation}</div></div></div>}
            {report && report.review_points.length > 0 && <div className="stack" style={{gap: 8}}>
              <small className="muted">Shared assets ranked by route count (review aid, not a minimum cut)</small>
              {report.review_points.slice(0, 5).map(p => <button key={p.asset_id} className="list-row" style={{padding: '4px 0', border: 0}} onClick={() => onSelect(p.asset_id)}>
                <span className="meta"><b>{p.label}</b><div className="bar" style={{marginTop: 5}}><span style={{width: `${(p.path_count / Math.max(1, report.review_points[0].path_count)) * 100}%`}}/></div></span>
                <span className="mono muted">{p.path_count}</span></button>)}
            </div>}
          </div>
        </section>

        <section className="card" aria-label="Candidate routes">
          <div className="card-head"><div><h2>Routes · {report?.universe.path_count ?? '…'}</h2><p>{report?.ordering ?? 'Loading…'}</p></div>
            {sweep?.running ? <button className="btn sm" onClick={stop}><Icon name="stop" size={13}/>Stop</button>
              : <button className="btn danger sm" disabled={!report?.assessments.length} onClick={() => void sweepAll()}><Icon name="bolt" size={14}/>Simulate all</button>}</div>
          {sweep && <div className="card-body" style={{borderBottom: '1px solid var(--border)'}}>
            <div className="row between" style={{fontSize: 12.5, marginBottom: 8}}><b>{sweep.running ? 'Sweeping routes…' : 'Sweep complete'}</b><span className="muted">{sweep.done}/{sweep.total}</span></div>
            <div className="progress"><span style={{width: `${(sweep.done / Math.max(1, sweep.total)) * 100}%`}}/></div>
            <div className="row" style={{marginTop: 10}}><span className="chip danger">{sweep.reached} reach critical</span><span className="chip info">{sweep.blocked} blocked by shield</span></div>
          </div>}
          <div className="list" style={{maxHeight: 520, overflow: 'auto'}}>
            {!report && <div className="card-body stack">{[0, 1, 2].map(i => <div key={i} className="skeleton" style={{height: 54}}/>)}</div>}
            {report?.assessments.length === 0 && <div className="empty"><Icon name="route"/><b>No candidate routes</b>
              <span>Mark entry and critical assets in the inspector, then collect their connectivity.</span></div>}
            {report?.assessments.map(route => <button key={route.id} className={`list-row ${active === route.id ? 'active' : ''}`} style={{alignItems: 'flex-start'}} onClick={() => { stop(); setActive(route.id) }}>
              <span className="mono muted" style={{paddingTop: 2}}>#{route.review_order}</span>
              <span className="meta">
                <b>{name(route.nodes[0])} → {name(route.nodes[route.nodes.length - 1])}</b>
                <small>{route.hop_count} hops · {route.issues.length ? `${route.issues.length} telemetry issue${route.issues.length > 1 ? 's' : ''}` : 'clean telemetry'}{shield && route.nodes.includes(shield) ? ' · interrupted by shield' : ''}</small>
                <span className="hops">{route.nodes.map((n, i) => <span key={n} className="row" style={{gap: 4}}>{i > 0 && <span className="hop-arrow">›</span>}<span className={`hop ${hopClass(route, i)}`}>{name(n)}</span></span>)}</span>
              </span>
            </button>)}
          </div>
        </section>
      </div>

      <div className="stack">
        <Twin3D ref={twin} topology={topology} selected={selected} onSelect={onSelect} height={540}>
          <div className="twin-hud">
            {path && <div className="hud-card">
              <h3><Icon name="route" size={15}/>Route #{path.review_order} · {path.hop_count} hops</h3>
              <p>{name(path.nodes[0])} → {name(path.nodes[path.nodes.length - 1])}{shield ? ` · shield on ${name(shield)}` : ''}</p>
              <div className="player" style={{marginTop: 10}}>
                {play && !play.outcome && !sweep?.running ? <button className="btn sm" onClick={stop}><Icon name="stop" size={13}/>Stop</button>
                  : <button className="btn danger sm" disabled={sweep?.running} onClick={() => void replay(path)}><Icon name="play" size={13}/>{play?.pathId === path.id && play.outcome ? 'Replay' : 'Replay attack'}</button>}
                <div className="progress"><span style={{width: `${play?.pathId === path.id ? ((play.outcome ? path.nodes.length - 1 : play.hop) / Math.max(1, path.nodes.length - 1)) * 100 : 0}%`}}/></div>
              </div>
            </div>}
            {play?.outcome === 'reached' && <div className="outcome reached"><Icon name="alert"/><div>Crown-jewel asset reached on this candidate<small>Replay of observed/inferred evidence. Validate each hop in a sandbox.</small></div></div>}
            {play?.outcome === 'blocked' && <div className="outcome blocked"><Icon name="shieldCheck"/><div>Route interrupted at {name(shield)}<small>Under the stated isolation assumption only — test real segmentation.</small></div></div>}
          </div>
        </Twin3D>

        {path && <section className="card" aria-label="Route evidence">
          <div className="card-head"><div><h2>Hop-by-hop evidence</h2><p>{path.next_action}</p></div><span className="chip warn">unvalidated</span></div>
          <div className="card-body">
            <ol className="timeline">
              {path.nodes.map((n, i) => {
                const step = i > 0 ? path.steps[i - 1] : null
                const blocked = play?.pathId === path.id && play.outcome === 'blocked' && n === shield
                const state = play?.pathId !== path.id ? '' : blocked ? 'blocked' : (i < play.hop || (play.outcome === 'reached')) ? 'done' : i === play.hop && !play.outcome ? 'now' : ''
                const issues = path.issues.filter(x => x.asset_id === n)
                return <li key={n} className={state}><span className="node"/>
                  <button className="btn ghost sm" style={{padding: 0, height: 'auto'}} onClick={() => { onSelect(n); twin.current?.focus(n) }}><b>{name(n)}</b></button>
                  {i === 0 && <span className="chip info" style={{marginLeft: 8}}>entry</span>}{i === path.nodes.length - 1 && <span className="chip violet" style={{marginLeft: 8}}>critical</span>}
                  {step && <small><span className={`chip ${step.kind === 'INFERRED_REACHABILITY' ? 'warn' : 'ok'}`} style={{height: 18, marginRight: 6}}>{readable(step.kind)}</span>
                    {step.freshness} evidence · {step.evidence_source ?? 'source not recorded'} · observed {ago(step.observed_at)}</small>}
                  {issues.map((x, k) => <small key={k} style={{color: '#b45309'}}><Icon name="alert" size={12}/> {readable(x.reason)}{x.gap_count ? ` (${x.gap_count} gaps)` : ''}</small>)}
                </li>
              })}
            </ol>
            <details className="disclosure" style={{marginTop: 6}}><summary>Analysis scope and assumptions</summary><div>
              <ul style={{margin: 0, paddingLeft: 18, color: 'var(--text-2)', fontSize: 13}}>{report?.universe.assumptions.map(a => <li key={a}>{a}</li>)}</ul>
              <p className="muted" style={{fontSize: 12, marginTop: 8}}>Limits: {report?.universe.max_paths} paths, {report?.universe.max_states.toLocaleString()} traversal states{report?.universe.truncated ? ' — results truncated' : ''}. Evidence older than {report?.universe.freshness_threshold_seconds}s is flagged.</p>
            </div></details>
          </div>
        </section>}
      </div>
    </div>
  </>
}
