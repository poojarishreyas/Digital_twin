import {useCallback, useEffect, useRef, useState} from 'react'
import {api, message} from '../api'
import type {Assessment, Host, PathReport, Topology} from '../types'
import {Twin3D, type TwinHandle} from '../twin/Twin3D'
import {Icon} from '../ui/icons'
import {Modal} from '../ui/Modal'
import type {PageProps} from '../ui/Inspector'
import {hostName} from '../useTwinData'
import {lastScannedGeneration, rememberScannedGeneration, SCAN_DURATION_MS, scanState, showCandidateRoutes, topologyPreviewRoute, twinGeneration} from './attack-path-flow'
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
  const [previewPath, setPreviewPath] = useState(false)
  const [previewRoutes, setPreviewRoutes] = useState<Assessment[]>([])
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
    if (phase === 'results' && previewPath && previewRoutes[0]) void replay(previewRoutes[0])
    else { playbackVersion.current++; twin.current?.stop(); setPlayback(null) }
  }, [phase, previewPath, previewRoutes, replay])

  useEffect(() => {
    if (phase === 'results' && investigation?.generation && investigation.codebase)
      rememberScannedGeneration(`${principal.tenant}:${investigation.codebase.url}`, investigation.generation)
  }, [phase, investigation, principal.tenant])

  async function analyze() {
    if (!source || !report || phase === 'analyzing' || fixing || preparing || principal.role === 'viewer') return
    setPreparing(true); setError('')
    let checked: CodebaseConnection
    let latestReport: PathReport, latestTopology: Topology, hosts: Host[]
    try {
      [checked, latestReport, latestTopology, hosts] = await Promise.all([
        refreshSource(), api.get<PathReport>('/api/paths?max_depth=4'), api.get<Topology>('/api/topology'), api.get<Host[]>('/api/hosts'),
      ])
    }
    catch (e) { setError(message(e)); setPreparing(false); return }
    setPreparing(false)
    if (!checked.codebase) return
    setReport(latestReport)
    playbackVersion.current++; twin.current?.stop(); setPlayback(null)
    const generation = twinGeneration(hosts, latestTopology)
    const previous = lastScannedGeneration(`${principal.tenant}:${checked.codebase.url}`)
    const newGeneration = !checked.codebase.vulnerable && previous !== null && previous !== generation
    const candidates = showCandidateRoutes(checked.codebase.vulnerable, previous, generation) ? latestReport.assessments : []
    const previewFallback = latestReport.assessments.length ? null : topologyPreviewRoute(latestTopology)
    setPreviewRoutes(latestReport.assessments.length ? latestReport.assessments.slice(0, 15) : previewFallback ? [previewFallback] : [])
    replayTopology.current = latestTopology
    setInvestigation({id: `TH-${Date.now().toString(36).toUpperCase()}`, capturedAt: new Date(Date.now()).toISOString(), routes: candidates.slice(0, 15), topology: latestTopology,
      total: candidates.length, truncated: latestReport.universe.truncated, codebase: checked.codebase, generation, newGeneration})
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

  const routes = previewPath ? previewRoutes : []
  const ready = !!report && !!source && !preparing && principal.role !== 'viewer'
  const running = phase === 'analyzing' || !!fixing || preparing
  const progress = phase === 'analyzing' ? ANALYSIS_STEPS : FIX_STEPS
  const progressStep = phase === 'analyzing' ? step : fixStep
  const activePath = routes.find(route => route.id === playback?.pathId)
  const rebuiltTwin = !!investigation?.newGeneration
  const noPathFound = phase === 'results' && routes.length === 0 && !rebuiltTwin
  const previewHidden = !previewPath && previewRoutes.length > 0
  const displayedInvestigation = investigation && {...investigation, routes, total: Math.max(report?.assessments.length ?? 0, routes.length),
    previewMode: previewPath ? 'path' as const : 'hidden' as const}
  const fixesInView = routes.filter(route => fixed.includes(route.id)).length
  const findings = investigation && <div className="stack" style={{gap: 14}}>
    <div className="row between">
      <div><h3>{routes.length ? `${routes.length} path${routes.length === 1 ? '' : 's'} in preview` : previewHidden ? 'No attack path shown' : rebuiltTwin ? 'New twin requires validation' : 'No attack path found'}</h3>
        <p className="muted">{rebuiltTwin ? 'This twin has a new host generation. The earlier clean result does not cover it; review these candidate routes. The repository repair is still present, but deployment to the new hosts is unverified.' : routes.length ? 'Pinned source findings with topology context, impact analysis and a reviewable repair.' : source?.status === 'fixed' ? 'The supported repair is present in the repository default branch. AWS deployment is not verified.' : 'No topology route was available to correlate with the source finding.'}</p></div>
      {routes.length > 0 && <span className="chip accent">{fixesInView}/{routes.length} fixes previewed</span>}
    </div>
    {routes.length === 0 && (previewHidden ? <div className="alert info" role="status">Path preview is off. Use the bottom-right switch to show candidate routes.</div> : rebuiltTwin ? <div className="alert info" role="status">No candidate topology route was returned. The rebuilt hosts still need runtime validation.</div>
      : <div className="finding-success" role="status"><Icon name="shieldCheck" size={20}/><div><b>Scan complete — no attack path found</b><small>{source?.status === 'fixed' ? 'Repository repair verified at the pinned commit. Live instance status has not been tested.' : 'Source may still be vulnerable; no connected topology route was available.'}</small></div></div>)}
    {source?.pr && source.vulnerable && <div className="alert info"><Icon name="file"/><div><a href={source.pr.url} target="_blank" rel="noreferrer"><b>Review repair PR #{source.pr.number} ↗</b></a><p>The fix is pending review. Merge it, then run analysis again to verify the default branch.</p></div></div>}
    <div className="row between"><small className="mono muted">Report {investigation.id}</small><AnalysisReportActions scan={displayedInvestigation!} fixed={fixed}/></div>
    {previewPath && (investigation.total > routes.length || investigation.truncated) && <p className="muted">Showing {routes.length} of {investigation.total} candidate routes{investigation.truncated ? ' in a truncated topology traversal' : ''}.</p>}
    {routes.map((route, index) => <FindingCard key={route.id} route={route} topology={investigation.topology} codebase={investigation.codebase?.vulnerable ? investigation.codebase : undefined}
      index={index + 1} fixed={fixed.includes(route.id)} fixing={fixing === route.id}
      playback={playback?.pathId === route.id ? playback : null}
      disabled={!!fixing || principal.role === 'viewer'} canFix={!!investigation.codebase?.vulnerable} onReplay={() => void replay(route, false)}
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
        <div><h2>{noPathFound ? previewHidden ? 'No attack path shown' : 'No attack path found' : phase === 'results' ? 'Investigation complete' : running ? 'Investigation in progress' : 'Find the path. Understand the risk.'}</h2>
          <p className="muted">{noPathFound ? previewHidden ? 'Path preview is off. Turn on the bottom-right switch to view candidate routes.' : 'Scan complete. No unresolved attack paths were found in this preview.' : phase === 'results' ? 'Review the example findings and try the remediation walkthrough.' : 'TwinHunter brings the route, an example vulnerability and its proposed fix into one guided investigation.'}</p></div>
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
          <div className="hud-card"><h3><Icon name="route" size={15}/>{playback.repaired ? 'Fix verification replay' : activePath.id.startsWith('preview-topology-') ? 'Illustrative topology route' : 'Discovered attack path'}</h3>
            <p>{hostName(investigation!.topology, activePath.nodes[0])} → {hostName(investigation!.topology, activePath.nodes.at(-1) ?? '')}</p>
            <div className="row" style={{marginTop: 10}}><span className={`chip ${playback.repaired ? 'info' : 'danger'}`}>{playback.outcome ? playback.outcome === 'blocked' ? 'Route blocked' : playback.outcome === 'reached' ? 'Critical asset reached' : '3D replay unavailable' : `Following hop ${playback.hop + 1}`}</span>
              <button className="btn sm" disabled={!!fixing} onClick={() => void replay(activePath, playback.repaired)}><Icon name="play" size={13}/>Replay path</button>
              {!fixed.includes(activePath.id) && investigation?.codebase?.vulnerable && <button className="btn primary sm" disabled={!!fixing || principal.role === 'viewer'} onClick={() => { void fix(activePath.id); setOpen(true) }}><Icon name="wrench" size={13}/>Fix now</button>}</div>
          </div>
          {playback.outcome === 'reached' && <div className="outcome reached"><Icon name="alert"/><div>{activePath.id.startsWith('preview-topology-') ? 'Connectivity preview reached the last asset' : 'Route replay reaches the critical asset'}<small>Illustrative topology replay · No live exploit was performed.</small></div></div>}
          {playback.outcome === 'blocked' && <div className="outcome blocked"><Icon name="shieldCheck"/><div>Fix preview blocks the attack path<small>Simulated access boundary at {hostName(investigation!.topology, playback.isolated ?? '')}.</small></div></div>}
        </div>}
      </Twin3D>
    </div>
    {phase === 'results' && <section className="card">
      <div className="card-head"><div><h2>Investigation findings</h2><p>Source snapshot · captured when the investigation started</p></div><span className="chip accent">Pinned source</span></div>
      <div className="card-body">{findings}</div>
    </section>}

    <button type="button" className={`path-preview-toggle ${previewPath ? 'on' : ''}`} aria-pressed={previewPath}
      onClick={() => setPreviewPath(value => !value)}>{previewPath ? 'Hide path preview' : 'Show path preview'}</button>
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

function FindingCard({route, topology, codebase, index, fixed, fixing, disabled, canFix, playback, onReplay, onFix}: {
  route: Assessment; topology: Topology; index: number; fixed: boolean; fixing: boolean; disabled: boolean; canFix: boolean
  codebase?: ScanReport['codebase']
  playback: Playback | null; onReplay: () => void; onFix: () => void
}) {
  const name = (id: string) => hostName(topology, id)
  const analysis = analyzeFinding(route, topology, codebase)
  return <article className={`attack-finding ${fixed ? 'fixed' : ''}`}>
    <div className="row between"><div className="row"><span className={`chip ${fixed ? 'ok' : analysis.severity === 'High' ? 'danger' : 'warn'}`}>{fixed ? 'Fix preview complete' : analysis.severity === 'High' ? 'High · scenario priority' : analysis.severity}</span><span className="chip">{analysis.category}</span><RouteStatus route={route}/></div><small className="mono muted">#{index} · {route.hop_count} hops</small></div>
    <div><h3>{analysis.title}</h3><p className="muted">{analysis.service}</p></div>
    <div className="report-basis"><b>{analysis.classification}</b><p>{analysis.basis}</p></div>
    <div><span className="finding-label">{route.id.startsWith('preview-topology-') ? 'Illustrative connectivity route' : 'Attack path'}</span><ol className="finding-path">{route.nodes.map((node, i) => <li key={node}>
      {i > 0 && <span aria-hidden="true" className="hop-arrow">→</span>}<span className={`hop ${playback?.isolated === node ? 'shield' : playback && i === playback.hop && !playback.outcome ? 'now' : playback && i <= playback.hop && playback.outcome !== 'cancelled' ? 'hit' : i === 0 ? 'entry' : i === route.nodes.length - 1 ? 'critical' : ''}`}>{name(node)}</span></li>)}</ol></div>
    <div><button className="btn sm" disabled={disabled} onClick={onReplay}><Icon name="play" size={14}/>{fixed ? 'Replay blocked path' : 'Replay attack path'}</button></div>
    <div className="finding-remedy"><Icon name="wrench" size={17}/><div><b>Proposed fix</b><p>{analysis.remediation[0]}</p></div></div>
    <FindingAnalysis route={route} topology={topology} analysis={analysis} fixed={fixed}/>
    {fixed ? <div className="finding-success" role="status"><Icon name="shieldCheck" size={18}/><div><b>Simulated fix applied and retested</b><small>The example route is blocked in this preview. No live configuration was changed.</small></div></div> :
      <div className="row between"><small className="muted">{route.issues.length ? `${route.issues.length} telemetry issues need review before real validation.` : 'Connectivity provides context; exploitability requires validation.'}</small>
        {canFix && <button className="btn primary" disabled={disabled} onClick={onFix}><Icon name={fixing ? 'pulse' : 'wrench'} size={15}/>{fixing ? 'Trying fix…' : 'Fix now'}</button>}</div>}
  </article>
}

function RouteStatus({route}: {route: Assessment}) {
  if (route.validation_status === 'proven') return <span className="chip danger">proven · every hop confirmed</span>
  if (route.validation_status === 'partially_confirmed') return <span className="chip warn">{route.confirmed_hops}/{route.hop_count} hops confirmed</span>
  return <span className="chip">Topology route unvalidated</span>
}
