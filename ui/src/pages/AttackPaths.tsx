import {useCallback, useEffect, useRef, useState} from 'react'
import {api, message} from '../api'
import type {Assessment, PathReport, Topology} from '../types'
import {Twin3D, type TwinHandle} from '../twin/Twin3D'
import {Icon} from '../ui/icons'
import {Modal} from '../ui/Modal'
import type {PageProps} from '../ui/Inspector'
import {hostName} from '../useTwinData'
import {SCAN_DURATION_MS, scanState} from './attack-path-flow'
import {AnalysisReportActions, FindingAnalysis, analyzeFinding} from './AttackPathAnalysis'
import type {ScanReport} from './attack-path-report'
import {useCodebase, type CodebaseConnection} from '../codebase'
import {useSession} from '../auth'

const ANALYSIS_STEPS = [
  ['Reading the digital twin', 'Collecting entry points, critical assets and connection evidence.'],
  ['Planning with the LLM', 'Building example hypotheses for the selected topology.'],
  ['Harness investigating paths', 'Walking each hop and illustrating a possible access-control weakness.'],
  ['Preparing scan results', 'Reviewing the paths and simulated fixes before reporting the result.'],
]
const FIX_STEPS = [
  ['Preparing the source repair', 'Checking the pinned commit and the supported authentication change.'],
  ['Creating the pull request', 'Writing the repaired file on a new branch and opening a GitHub pull request.'],
]
type Phase = 'ready' | 'analyzing' | 'results'
type Investigation = ScanReport
type Playback = {pathId: string; hop: number; repaired: boolean; isolated: string | null; outcome?: 'reached' | 'blocked' | 'cancelled'}

export function AttackPaths({data, selected, onSelect, go}: PageProps) {
  const {principal} = useSession()
  const {connection, setConnection, loading: sourceLoading, error: sourceError, refresh: refreshSource} = useCodebase()
  const source = connection.codebase
  const twin = useRef<TwinHandle>(null)
  const playbackVersion = useRef(0)
  const replayTopology = useRef(data.topology)
  const [report, setReport] = useState<PathReport | null>(null), [error, setError] = useState('')
  const [open, setOpen] = useState(true), [phase, setPhase] = useState<Phase>('ready'), [step, setStep] = useState(0)
  const [investigation, setInvestigation] = useState<Investigation | null>(null)
  const [fixing, setFixing] = useState<string | null>(null), [fixStep, setFixStep] = useState(0)
  const fixed: string[] = []
  const [preparing, setPreparing] = useState(false)
  const [scanStartedAt, setScanStartedAt] = useState<number | null>(null)
  const [playback, setPlayback] = useState<Playback | null>(null)
  const close = useCallback(() => setOpen(false), [])
  const replay = useCallback(async (route: Assessment, repaired = false) => {
    const version = ++playbackVersion.current
    const isolated = repaired ? analyzeFinding(route, replayTopology.current).controlAssetId : null
    setOpen(false)
    setPlayback({pathId: route.id, hop: 0, repaired, isolated})
    const outcome = await twin.current?.playAttack(route.nodes, isolated,
      hop => { if (version === playbackVersion.current) setPlayback({pathId: route.id, hop, repaired, isolated}) })
    if (version === playbackVersion.current) setPlayback(value => value && {...value, outcome: outcome ?? 'cancelled'})
  }, [])

  useEffect(() => {
    const view = twin.current
    return () => { playbackVersion.current++; view?.stop() }
  }, [])

  useEffect(() => {
    if (!source) return
    let live = true
    api.get<PathReport>('/api/paths?max_depth=4').then(value => {
      if (live) { setReport(value); setError('') }
    }).catch(e => { if (live) setError(message(e)) })
    return () => { live = false }
  }, [data.updated, source?.url])

  useEffect(() => {
    if (phase !== 'analyzing' || scanStartedAt === null) return
    // Use elapsed time so a background tab catches up without restarting or
    // adding another full stage delay after a throttled browser callback.
    function update() {
      const state = scanState(scanStartedAt!, Date.now())
      setStep(state.step)
      if (state.complete) setPhase('results')
    }
    update()
    const timer = window.setInterval(update, 1000)
    const finish = window.setTimeout(update, Math.max(0, SCAN_DURATION_MS - (Date.now() - scanStartedAt)))
    document.addEventListener('visibilitychange', update)
    return () => { window.clearInterval(timer); window.clearTimeout(finish); document.removeEventListener('visibilitychange', update) }
  }, [phase, scanStartedAt])

  useEffect(() => {
    if (phase === 'results' && investigation?.routes[0]) void replay(investigation.routes[0])
  }, [phase, investigation, replay])

  async function analyze() {
    if (!source || !report || error || phase === 'analyzing' || fixing || preparing || principal.role === 'viewer') return
    setPreparing(true); setError('')
    let checked: CodebaseConnection
    try { checked = await refreshSource() }
    catch (e) { setError(message(e)); setPreparing(false); return }
    setPreparing(false)
    if (!checked.codebase) return
    playbackVersion.current++; twin.current?.stop(); setPlayback(null)
    // A PR does not repair the default branch. Only re-read, fixed source can
    // suppress this fixture finding. Runtime deployment remains unverified.
    const unresolved = checked.codebase.vulnerable ? report.assessments : []
    replayTopology.current = data.topology
    setInvestigation({id: `TH-${Date.now().toString(36).toUpperCase()}`, capturedAt: new Date(Date.now()).toISOString(), routes: unresolved.slice(0, 15), topology: data.topology,
      total: unresolved.length, truncated: report.universe.truncated, codebase: checked.codebase})
    setStep(0); setScanStartedAt(Date.now()); setPhase('analyzing'); setOpen(true)
  }
  async function fix(id: string) {
    if (fixing || !investigation?.codebase || principal.role === 'viewer') return
    if (!connection.pr_enabled) { setError('GitHub write access is required to create a repair PR. Configure the workspace integration from Codebase.'); setOpen(true); return }
    playbackVersion.current++; twin.current?.stop(); setPlayback(null)
    setFixStep(0); setFixing(id)
    try {
      setFixStep(1)
      const result = await api.post<CodebaseConnection>('/api/codebase/repair', {commit: investigation.codebase.commit, repository: investigation.codebase.slug})
      setConnection(result); setOpen(true); setError('')
    } catch (e) { setError(message(e)); setOpen(true) }
    finally { setFixing(null) }
  }

  const routes = investigation?.routes ?? []
  const ready = !!report && !!source && !preparing && principal.role !== 'viewer'
  const running = phase === 'analyzing' || !!fixing || preparing
  const progress = phase === 'analyzing' ? ANALYSIS_STEPS : FIX_STEPS
  const progressStep = phase === 'analyzing' ? step : fixStep
  const activePath = routes.find(route => route.id === playback?.pathId)
  const noPathFound = phase === 'results' && routes.length === 0
  const fixesInView = routes.filter(route => fixed.includes(route.id)).length
  const findings = investigation && <div className="stack" style={{gap: 14}}>
    <div className="row between">
      <div><h3>{routes.length ? `${routes.length} finding${routes.length === 1 ? '' : 's'} for review` : 'No attack path found'}</h3>
        <p className="muted">{routes.length ? 'Pinned source findings with topology context, impact analysis and a reviewable repair.' : source?.status === 'fixed' ? 'The supported repair is present in the repository default branch. AWS deployment is not verified.' : 'No topology route was available to correlate with the source finding.'}</p></div>
      {routes.length > 0 && <span className="chip accent">{fixesInView}/{routes.length} fixes previewed</span>}
    </div>
    {routes.length === 0 && <div className="finding-success" role="status"><Icon name="shieldCheck" size={20}/><div><b>Scan complete — no attack path found</b><small>{source?.status === 'fixed' ? 'Repository repair verified at the pinned commit. Live instance status has not been tested.' : 'Source may still be vulnerable; no connected topology route was available.'}</small></div></div>}
    {source?.pr && source.vulnerable && <div className="alert info"><Icon name="file"/><div><a href={source.pr.url} target="_blank" rel="noreferrer"><b>Review repair PR #{source.pr.number} ↗</b></a><p>The fix is pending review. Merge it, then run analysis again to verify the default branch.</p></div></div>}
    <div className="row between"><small className="mono muted">Report {investigation.id}</small><AnalysisReportActions scan={investigation} fixed={fixed}/></div>
    {(investigation.total > routes.length || investigation.truncated) && <p className="muted">Showing {routes.length} of {investigation.total} candidate routes{investigation.truncated ? ' in a truncated topology traversal' : ''}.</p>}
    {routes.map((route, index) => <FindingCard key={route.id} route={route} topology={investigation.topology} codebase={investigation.codebase}
      index={index + 1} fixed={fixed.includes(route.id)} fixing={fixing === route.id}
      playback={playback?.pathId === route.id ? playback : null}
      disabled={!!fixing || principal.role === 'viewer' || !!source?.pr && source.pr.base_commit === investigation.codebase?.commit} onReplay={() => void replay(route, false)}
      onFix={() => { void fix(route.id); setOpen(true) }}/>) }
  </div>

  if (sourceLoading || !source) return <>
    <div className="page-head"><div><span className="eyebrow"><Icon name="lock" size={14}/>Source required</span><h1>Attack paths</h1><p>Connect a codebase before starting analysis or creating a repair.</p></div></div>
    {sourceError && <div className="alert danger" role="alert">{sourceError}</div>}
    <section className="card"><div className="empty"><Icon name="lock"/><b>{sourceLoading ? 'Checking codebase…' : 'Add your GitHub codebase first'}</b><span>Analysis is locked until a workspace repository has been verified.</span><button className="btn primary" disabled={sourceLoading} onClick={() => go('codebase')}>Open Codebase</button></div></section>
  </>

  return <>
    <div className="page-head">
      <div><span className="eyebrow"><Icon name="route" size={14}/>TwinHunter investigation</span><h1>Attack paths</h1>
        <p>Start an investigation to explore vulnerabilities, trace the affected paths and preview a fix.</p></div>
      <button className="btn primary" onClick={() => setOpen(true)}><Icon name="spark" size={16}/>{running ? 'View progress' : phase === 'results' ? 'View findings' : 'Analyze attack paths'}</button>
    </div>
    <div className="alert info"><Icon name="file"/><span><b>{source.slug}</b> · Source checks use a pinned GitHub commit. The three-minute topology replay is illustrative. Fix now creates a real PR; it does not merge or deploy to AWS.</span></div>
    {error && <div className="alert danger" role="alert"><Icon name="alert"/>{error}</div>}
    <div className="split attack-workspace">
      <section className="card card-pad stack">
        <span className="analysis-emblem"><Icon name="spark" size={28}/></span>
        <div><h2>{noPathFound ? 'No attack path found' : phase === 'results' ? 'Investigation complete' : running ? 'Investigation in progress' : 'Find the path. Understand the risk.'}</h2>
          <p className="muted">{noPathFound ? 'Scan complete. No unresolved attack paths were found in this preview.' : phase === 'results' ? 'Review the example findings and try the remediation walkthrough.' : 'TwinHunter brings the route, an example vulnerability and its proposed fix into one guided investigation.'}</p></div>
        <div className="analysis-stats">
          <div><b>{report?.universe.entries.length ?? '—'}</b><small>Entry points</small></div>
          <div><b>{report?.universe.critical.length ?? '—'}</b><small>Critical assets</small></div>
          <div><b>{report?.universe.path_count ?? '—'}</b><small>Discovered routes</small></div>
        </div>
        <button className="btn primary" onClick={() => setOpen(true)}><Icon name={running ? 'pulse' : 'spark'} size={16}/>{running ? 'View harness progress' : phase === 'results' ? 'Open findings' : 'Open analysis'}</button>
        <small className="muted">{running ? 'The walkthrough continues when you close the modal.' : phase === 'results' ? 'Run again in the modal to use the latest topology.' : report ? 'Topology loaded. Start analysis in the modal.' : error ? 'Resolve the connection error to start.' : 'Loading topology…'}</small>
      </section>
      <Twin3D ref={twin} topology={investigation?.topology ?? data.topology} selected={selected} onSelect={onSelect} height={540}>
        {activePath && playback && <div className="twin-hud">
          <div className="hud-card"><h3><Icon name="route" size={15}/>{playback.repaired ? 'Fix verification replay' : 'Discovered attack path'}</h3>
            <p>{hostName(investigation!.topology, activePath.nodes[0])} → {hostName(investigation!.topology, activePath.nodes.at(-1) ?? '')}</p>
            <div className="row" style={{marginTop: 10}}><span className={`chip ${playback.repaired ? 'info' : 'danger'}`}>{playback.outcome ? playback.outcome === 'blocked' ? 'Route blocked' : playback.outcome === 'reached' ? 'Critical asset reached' : '3D replay unavailable' : `Following hop ${playback.hop + 1}`}</span>
              <button className="btn sm" disabled={!!fixing} onClick={() => void replay(activePath, playback.repaired)}><Icon name="play" size={13}/>Replay path</button>
              {!fixed.includes(activePath.id) && <button className="btn primary sm" disabled={!!fixing || principal.role === 'viewer' || !!source.pr && source.pr.base_commit === investigation?.codebase?.commit} onClick={() => { void fix(activePath.id); setOpen(true) }}><Icon name="wrench" size={13}/>Fix now</button>}</div>
          </div>
          {playback.outcome === 'reached' && <div className="outcome reached"><Icon name="alert"/><div>Route replay reaches the critical asset<small>Illustrative topology replay · Fix now proposes a source repair PR.</small></div></div>}
          {playback.outcome === 'blocked' && <div className="outcome blocked"><Icon name="shieldCheck"/><div>Fix preview blocks the attack path<small>Simulated access boundary at {hostName(investigation!.topology, playback.isolated ?? '')}.</small></div></div>}
        </div>}
      </Twin3D>
    </div>
    {phase === 'results' && <section className="card">
      <div className="card-head"><div><h2>Investigation findings</h2><p>Source snapshot · captured when the investigation started</p></div><span className="chip accent">Pinned source</span></div>
      <div className="card-body">{findings}</div>
    </section>}

    {open && <Modal title="Analyze attack paths" subtitle="TwinHunter · source and topology review" width={860} onClose={close}>
      <div className="stack">
        <div className="alert info"><Icon name="file"/><span><b>Source-backed analysis</b> · Code is checked at a pinned commit. Path animation is illustrative; no live exploit or AWS change is performed.</span></div>
        {error && <div className="alert danger" role="alert">{error}</div>}
        {phase === 'ready' && <>
          <div className="analysis-intro"><span className="analysis-emblem"><Icon name="spark" size={32}/></span>
            <h2>Investigate before you act</h2><p>Check the connected source, follow the topology route and review a proposed code repair.</p></div>
          <ol className="analysis-checklist">{[['Analyze', 'Verify the connected repository commit.'], ['Investigate', 'Review source evidence and topology context.'], ['Remediate', 'Create and review a repair pull request.']].map(([title, text], index) =>
            <li key={title}><span>{index + 1}</span><div><b>{title}</b><small>{text}</small></div></li>)}</ol>
          {error && <div className="alert danger" role="alert">Could not load attack paths: {error}</div>}
          <div className="row between"><small className="muted">{ready ? `${report.universe.path_count} candidate routes available for this preview` : error ? 'Reconnect to load your topology.' : 'Loading candidate routes…'}</small>
            <button className="btn primary" disabled={!ready} onClick={() => void analyze()}><Icon name="spark" size={16}/>{preparing ? 'Checking source…' : 'Analyze code and paths'}</button></div>
        </>}
        {running && <section className="harness-progress" aria-label={phase === 'analyzing' ? 'Analysis progress' : 'Fix progress'} aria-busy="true">
          <div className="row"><span className="chip accent"><Icon name="pulse" size={13}/>Harness preview running</span></div>
          <div role="status" aria-live="polite"><h3>{progress[progressStep][0]}</h3><p className="muted">{progress[progressStep][1]}</p></div>
          <div className="progress scan-activity" aria-hidden="true"><span/></div>
          <ol className="harness-trace">{progress.map(([title], index) => <li key={title} className={index < progressStep ? 'done' : index === progressStep ? 'on' : ''}>
            <Icon name={index < progressStep ? 'check' : index === progressStep ? 'pulse' : 'clock'} size={15}/>{title}<small>{index < progressStep ? 'Done' : index === progressStep ? 'In progress' : 'Waiting'}</small></li>)}</ol>
        </section>}
        {phase === 'results' && <>
          <div role="status" className="row"><Icon name="check" size={18}/><b>Analysis preview complete</b></div>
          {findings}
          <div className="row between"><button className="btn" disabled={!ready || !!fixing} onClick={analyze}><Icon name="refresh" size={15}/>Run again</button><button className="btn" onClick={close}>Close</button></div>
        </>}
      </div>
    </Modal>}
  </>
}

function FindingCard({route, topology, codebase, index, fixed, fixing, disabled, playback, onReplay, onFix}: {
  route: Assessment; topology: Topology; index: number; fixed: boolean; fixing: boolean; disabled: boolean
  codebase?: ScanReport['codebase']
  playback: Playback | null; onReplay: () => void; onFix: () => void
}) {
  const name = (id: string) => hostName(topology, id)
  const analysis = analyzeFinding(route, topology, codebase)
  return <article className={`attack-finding ${fixed ? 'fixed' : ''}`}>
    <div className="row between"><div className="row"><span className={`chip ${fixed ? 'ok' : analysis.severity === 'High' ? 'danger' : 'warn'}`}>{fixed ? 'Fix preview complete' : analysis.severity === 'High' ? 'High · scenario priority' : analysis.severity}</span><span className="chip">{analysis.category}</span></div><small className="mono muted">#{index} · {route.hop_count} hops</small></div>
    <div><h3>{analysis.title}</h3><p className="muted">{analysis.service}</p></div>
    <div className="report-basis"><b>{analysis.classification}</b><p>{analysis.basis}</p></div>
    <div><span className="finding-label">Attack path</span><ol className="finding-path">{route.nodes.map((node, i) => <li key={node}>
      {i > 0 && <span aria-hidden="true" className="hop-arrow">→</span>}<span className={`hop ${playback?.isolated === node ? 'shield' : playback && i === playback.hop && !playback.outcome ? 'now' : playback && i <= playback.hop && playback.outcome !== 'cancelled' ? 'hit' : i === 0 ? 'entry' : i === route.nodes.length - 1 ? 'critical' : ''}`}>{name(node)}</span></li>)}</ol></div>
    <div><button className="btn sm" disabled={disabled} onClick={onReplay}><Icon name="play" size={14}/>{fixed ? 'Replay blocked path' : 'Replay attack path'}</button></div>
    <div className="finding-remedy"><Icon name="wrench" size={17}/><div><b>Proposed fix</b><p>{analysis.remediation[0]}</p></div></div>
    <FindingAnalysis route={route} topology={topology} analysis={analysis} fixed={fixed}/>
    {fixed ? <div className="finding-success" role="status"><Icon name="shieldCheck" size={18}/><div><b>Simulated fix applied and retested</b><small>The example route is blocked in this preview. No live configuration was changed.</small></div></div> :
      <div className="row between"><small className="muted">{route.issues.length ? `${route.issues.length} telemetry issues need review before real validation.` : 'Connectivity provides context; exploitability requires validation.'}</small>
        <button className="btn primary" disabled={disabled} onClick={onFix}><Icon name={fixing ? 'pulse' : 'wrench'} size={15}/>{fixing ? 'Trying fix…' : 'Fix now'}</button></div>}
  </article>
}
