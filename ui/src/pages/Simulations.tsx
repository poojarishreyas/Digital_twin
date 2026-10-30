import {useCallback, useEffect, useRef, useState} from 'react'
import {api, message} from '../api'
import {useSession} from '../auth'
import type {Finding, Plan, Run, RunDetail, Verdict} from '../types'
import {Twin3D, type TwinHandle} from '../twin/Twin3D'
import type {SimulationWave} from '../twin/engine'
import {Icon} from '../ui/icons'
import type {PageProps} from '../ui/Inspector'
import {ago, hostName} from '../useTwinData'

const PHASES = [['cloning', 'Clone', 'Snapshot services into the sandbox'], ['probing', 'Probe', 'Deterministic checks on isolated networks'],
  ['verdicts', 'Verdict', 'Record evidence with fidelity gaps'], ['cleanup', 'Teardown', 'Remove labeled resources']] as const
const downloadJson = (name: string, value: unknown) => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], {type: 'application/json'}))
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url)
}

const SEVERITY: Verdict[] = ['confirmed', 'inconclusive', 'not_reproduced', 'unsupported']
const VERDICT_LABEL: Record<Verdict, string> = {confirmed: 'Confirmed', not_reproduced: 'Not reproduced', inconclusive: 'Inconclusive', unsupported: 'Unsupported'}
const VERDICT_TONE: Record<Verdict, string> = {confirmed: 'danger', not_reproduced: 'ok', inconclusive: 'warn', unsupported: ''}

/** Most severe verdict per service, used to colour sandbox clones. */
function worst(findings: Finding[], id: string): Verdict | undefined {
  const verdicts = findings.filter(f => f.target_id === id).map(f => f.verdict)
  return SEVERITY.find(v => verdicts.includes(v))
}

export function Simulations({data, selected, onSelect}: PageProps) {
  const {principal} = useSession()
  const twin = useRef<TwinHandle>(null)
  const [runs, setRuns] = useState<Run[]>([]), [chosen, setChosen] = useState<string | null>(null), [detail, setDetail] = useState<RunDetail | null>(null)
  const [error, setError] = useState(''), [phase, setPhase] = useState<{wave: number; phase: string} | null>(null), [filter, setFilter] = useState<Verdict | 'all'>('all')
  const canOperate = principal.role !== 'viewer'

  const refresh = useCallback(async () => {
    try {
      const latest = await api.get<Run[]>('/api/emulation/runs')
      setRuns(latest)
      const id = chosen ?? latest[0]?.id
      if (id) { setDetail(await api.get<RunDetail>(`/api/emulation/runs/${id}`)); setChosen(id) }
      setError('')
    } catch (e) { setError(message(e)) }
  }, [chosen])
  useEffect(() => { void refresh(); const timer = setInterval(refresh, 5000); return () => clearInterval(timer) }, [refresh])

  async function exportSarif() {
    if (!chosen) return
    try { downloadJson(`twin-findings-${chosen.slice(0, 8)}.sarif.json`, await api.get(`/api/emulation/runs/${chosen}/sarif`)) }
    catch (e) { setError(message(e)) }
  }

  async function replay() {
    if (!detail?.run.plan) return
    const waves: SimulationWave[] = detail.run.plan.waves.map(w => ({index: w.index, services: w.service_ids.map(id => ({id, verdict: worst(detail.findings, id)}))}))
    setPhase({wave: waves[0]?.index ?? 0, phase: 'cloning'})
    await twin.current!.playSimulation(waves, (wave, p) => setPhase({wave, phase: p}))
  }
  function stop() { twin.current?.stop(); setPhase(null) }

  const plan = detail?.run.plan
  const findings = (detail?.findings ?? []).filter(f => filter === 'all' || f.verdict === filter)
  const counts = Object.fromEntries(SEVERITY.map(v => [v, detail?.findings.filter(f => f.verdict === v).length ?? 0])) as Record<Verdict, number>
  const total = detail?.findings.length ?? 0
  const phaseIndex = phase ? PHASES.findIndex(p => p[0] === phase.phase) : -1

  return <>
    <div className="page-head">
      <div><span className="eyebrow"><Icon name="flask" size={14}/>Selective emulation</span><h1>Sandbox simulations</h1>
        <p>Plans pick whole service bundles that cover candidate routes within the CPU/RAM budget. Each wave clones services into disposable twins on tenant-labeled internal networks, runs deterministic probes and tears everything down.</p></div>
    </div>
    {error && <div className="alert danger" role="alert"><Icon name="alert"/>{error}</div>}

    <div className="split">
      <div className="stack">
        {canOperate && <Planner onQueued={id => { setChosen(id); void refresh() }}/>}
        <section className="card" aria-label="Simulation runs">
          <div className="card-head"><div><h2>Runs · {runs.length}</h2><p>Newest first, scoped to this workspace</p></div>
            <button className="icon-btn" aria-label="Refresh runs" onClick={() => void refresh()}><Icon name="refresh" size={16}/></button></div>
          <div className="list" style={{maxHeight: 460, overflow: 'auto'}}>
            {runs.length === 0 && <div className="empty"><Icon name="flask"/><b>No runs yet</b><span>{canOperate ? 'Generate a plan above to queue the first run.' : 'An operator can queue runs for this workspace.'}</span></div>}
            {runs.map(r => <button key={r.id} className={`list-row ${chosen === r.id ? 'active' : ''}`} onClick={() => { stop(); setChosen(r.id); setDetail(null) }}>
              <span className="os-badge"><Icon name={r.status === 'running' ? 'pulse' : 'flask'} size={16}/></span>
              <span className="meta"><b className="mono">{r.id.slice(0, 8)}</b><small>{ago(r.created_at)} · peak {r.peak_ram_mb} MB · cleanup {r.cleanup_status}</small></span>
              <span className={`chip ${r.status === 'completed' ? 'ok' : r.status === 'failed' || r.status === 'interrupted' ? 'danger' : 'accent'}`}><span className="dot"/>{r.status}</span>
            </button>)}
          </div>
        </section>
      </div>

      <div className="stack">
        <Twin3D ref={twin} topology={data.topology} selected={selected} onSelect={onSelect} height={500}>
          <div className="twin-hud">
            {detail && <div className="hud-card">
              <h3><Icon name="flask" size={15}/>Run {detail.run.id.slice(0, 8)} · {plan?.waves.length ?? 0} waves</h3>
              <p>{plan?.planned_paths ?? 0} routes planned · {detail.validated_path_ids.length} validated end-to-end</p>
              <div className="row" style={{marginTop: 10}}>
                {phase && phase.phase !== 'done' ? <button className="btn sm" onClick={stop}><Icon name="stop" size={13}/>Stop</button>
                  : <button className="btn primary sm" disabled={!plan?.waves.length} onClick={() => void replay()}><Icon name="play" size={13}/>Replay emulation</button>}
                {phase && <span className="chip accent">{phase.phase === 'done' ? 'Replay finished' : `Wave ${phase.wave} · ${phase.phase}`}</span>}
              </div>
            </div>}
          </div>
        </Twin3D>

        {detail && <>
          <div className="phases" aria-label="Emulation phases">{PHASES.map(([id, label, note], i) =>
            <div key={id} className={`phase ${phaseIndex === i ? 'on' : phase && (phaseIndex > i || phase.phase === 'done') ? 'done' : ''}`}><b>{i + 1}. {label}</b>{note}</div>)}</div>

          <section className="kpis" style={{gridTemplateColumns: 'repeat(4, minmax(0, 1fr))'}}>
            {[['Validated routes', `${detail.validated_path_ids.length}/${plan?.path_universe_size ?? 0}`, 'shieldCheck', 'ok'],
              ['Untested routes', plan?.untested_paths ?? 0, 'route', (plan?.untested_paths ?? 0) ? 'warn' : ''],
              ['Peak resources', `${detail.run.peak_cpu_millis}m · ${detail.run.peak_ram_mb}MB`, 'pulse', ''],
              ['Cleanup', detail.run.cleanup_status, 'check', detail.run.cleanup_status === 'complete' ? 'ok' : 'warn']].map(([label, value, icon, tone]) =>
              <article key={String(label)} className={`card kpi ${tone}`}><div className="kpi-top">{label}<span className="kpi-icon"><Icon name={String(icon)} size={16}/></span></div><strong style={{fontSize: 22}}>{value}</strong></article>)}
          </section>

          <section className="card" aria-label="Waves">
            <div className="card-head"><div><h2>Waves</h2><p>Each wave carries every dependency service for the routes it claims</p></div>
              <div className="legend-row">{SEVERITY.map(v => <span key={v}><i className={`v-${v}`}/>{VERDICT_LABEL[v]}</span>)}</div></div>
            <div className="card-body grid-3" style={{gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12}}>
              {(plan?.waves ?? []).map(w => {
                const state = detail.waves.find(x => x.wave_index === w.index), own = detail.findings.filter(f => w.service_ids.includes(f.target_id))
                return <article key={w.index} className={`wave-card ${phase?.wave === w.index && phase.phase !== 'done' ? 'on' : ''}`}>
                  <div className="row between"><b>Wave {w.index}</b><span className={`chip ${state?.status === 'completed' ? 'ok' : state?.status === 'failed' ? 'danger' : 'accent'}`}>{state?.status ?? 'queued'}</span></div>
                  <small className="muted">{w.cpu_millis}m CPU · {w.ram_mb} MB · {w.path_ids.length} routes</small>
                  <div className="verdicts">{SEVERITY.map(v => { const n = own.filter(f => f.verdict === v).length; return n ? <span key={v} className={`v-${v}`} style={{width: `${(n / own.length) * 100}%`}}/> : null })}</div>
                  <div className="row" style={{gap: 4}}>{w.service_ids.map(id => <button key={id} className="hop" style={{border: 0, cursor: 'pointer'}} onClick={() => onSelect(id)}>
                    {id.split(':').at(-1)} · {hostName(data.topology, id.split(':')[1] ?? id)}</button>)}</div>
                </article>
              })}
            </div>
            {(plan?.excluded.length ?? 0) > 0 && <div className="card-body" style={{borderTop: '1px solid var(--border)'}}>
              <details className="disclosure"><summary>Excluded state · {plan!.excluded.length}</summary><div>
                {plan!.excluded.map((x, i) => <p key={i} style={{fontSize: 12.5}}><code>{x.id}</code> — <span className="muted">{x.reason}</span></p>)}</div></details></div>}
          </section>

          <section className="card" aria-label="Findings">
            <div className="card-head"><div><h2>Evidence · {total} findings</h2><p>Verdicts describe the rendered twin under recorded conditions, not the enrolled host</p></div>
              <div className="row" style={{gap: 8}}>
              <button className="btn sm" disabled={!total} onClick={() => void exportSarif()} title="Export findings as SARIF 2.1.0"><Icon name="download" size={14}/>SARIF</button>
              <div className="segmented" role="group" aria-label="Filter by verdict">
                <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All</button>
                {SEVERITY.map(v => <button key={v} className={filter === v ? 'on' : ''} onClick={() => setFilter(v)}>{VERDICT_LABEL[v]} {counts[v]}</button>)}</div></div></div>
            {findings.length === 0 ? <div className="empty"><b>No findings{filter !== 'all' ? ' for this verdict' : ' yet'}</b></div> :
              <div className="table-wrap"><table className="table"><thead><tr><th>Verdict</th><th>Test</th><th>Target</th><th>Image / snapshot</th><th>Fidelity</th><th>Recorded</th></tr></thead>
                <tbody>{findings.map(f => <tr key={f.id} className="clickable" onClick={() => onSelect(f.target_id)}>
                  <td><span className={`chip ${VERDICT_TONE[f.verdict]}`}><span className="dot"/>{VERDICT_LABEL[f.verdict]}</span></td>
                  <td className="mono">{f.test_id}</td><td><b>{f.target_id.split(':').at(-1)}</b><div className="muted" style={{fontSize: 12}}>{hostName(data.topology, f.target_id.split(':')[1] ?? '')}</div></td>
                  <td className="mono muted" style={{fontSize: 11.5}}>{f.image_id.slice(0, 19)}<br/>{f.snapshot_hash.slice(0, 19)}</td>
                  <td>{f.fidelity_gaps.length ? <span className="chip warn" title={f.fidelity_gaps.join('; ')}>{f.fidelity_gaps.length} gap{f.fidelity_gaps.length > 1 ? 's' : ''}</span> : <span className="chip ok">full</span>}</td>
                  <td>{ago(f.recorded_at)}</td></tr>)}</tbody></table></div>}
          </section>
        </>}
      </div>
    </div>
  </>
}

function Planner({onQueued}: {onQueued: (runId: string) => void}) {
  const [hops, setHops] = useState(4), [cpu, setCpu] = useState(2000), [ram, setRam] = useState(4096)
  const [plan, setPlan] = useState<{plan_id: string; plan: Plan} | null>(null), [busy, setBusy] = useState(false), [note, setNote] = useState('')
  async function generate() {
    setBusy(true); setNote('')
    try { setPlan(await api.post('/api/emulation/plans', {max_hops: hops, cpu_budget_millis: cpu, ram_budget_mb: ram})) } catch (e) { setNote(message(e)) } finally { setBusy(false) }
  }
  async function queue() {
    if (!plan) return
    setBusy(true); setNote('')
    try { const r = await api.post<{run_id: string}>('/api/emulation/runs', {plan_id: plan.plan_id}); setPlan(null); onQueued(r.run_id) } catch (e) { setNote(message(e)) } finally { setBusy(false) }
  }
  return <section className="card" aria-label="Plan a simulation">
    <div className="card-head"><div><h2>Plan a simulation</h2><p>Greedy path coverage per normalized CPU/RAM cost</p></div><Icon name="sliders"/></div>
    <div className="card-body stack" style={{gap: 12}}>
      <div className="row" style={{gap: 10, flexWrap: 'nowrap'}}>
        <label className="field" style={{flex: 1}}>Max hops<input className="input" type="number" min={1} max={8} value={hops} onChange={e => setHops(Number(e.target.value))}/></label>
        <label className="field" style={{flex: 1}}>CPU (m)<input className="input" type="number" min={1} step={100} value={cpu} onChange={e => setCpu(Number(e.target.value))}/></label>
        <label className="field" style={{flex: 1}}>RAM (MB)<input className="input" type="number" min={1} step={256} value={ram} onChange={e => setRam(Number(e.target.value))}/></label>
      </div>
      {!plan ? <button className="btn" disabled={busy} onClick={() => void generate()}><Icon name="layers" size={16}/>{busy ? 'Planning…' : 'Generate plan'}</button> : <>
        <div className="alert info"><Icon name="layers"/><div><b>{plan.plan.waves.length} waves cover {plan.plan.planned_paths} of {plan.plan.path_universe_size} routes</b>
          <div style={{fontSize: 12}}>{plan.plan.untested_paths} untested · {plan.plan.excluded.length} excluded items</div></div></div>
        <div className="row"><button className="btn primary" style={{flex: 1}} disabled={busy || !plan.plan.waves.length} onClick={() => void queue()}><Icon name="play" size={14}/>{busy ? 'Queueing…' : 'Queue run'}</button>
          <button className="btn ghost" onClick={() => setPlan(null)}>Discard</button></div>
      </>}
      {note && <div className="alert danger" role="alert"><Icon name="alert"/>{note}</div>}
    </div>
  </section>
}
