import {useEffect, useState} from 'react'
import {api, message} from '../api'
import {useSession} from '../auth'
import {Icon} from '../ui/icons'

type Observation = {
  request_id: string; actor: string; record: string; http_status: number; chain_verified: boolean
  returned_expected_record: boolean; gateway_correlated: boolean; api_correlated: boolean
  client_context?: string
  verdict?: string; database_audit: {actor: string; record: string; status: number} | null
}
type Patch = {
  label: string; change: {component: string; field: string; before: string; after: string}
  original_security: Observation; security_retest?: Observation
  original_workflows: {passed: boolean; observations: Observation[]}
  candidate_workflows?: {passed: boolean; observations: Observation[]}
  same_application_images?: boolean; candidate_cleanup?: string; error?: string
}
type Result = {
  status: string; attack_path_confirmed: boolean; repair_verified: boolean; cleanup: string
  assumptions: string[]; limitations: string[]; isolation: {passed: boolean; checks: Record<string, boolean>}
  hunter: {status: string; evidence: (Observation & {tool: string})[]; patches: Patch[]
    reported_tokens: number | null; model: {requested_model?: string}; trace: unknown[]
    trace_integrity: {verified: boolean}}
}
type Run = {
  id: string; status: string; artifact_id: string; created_at: string; error?: string
  discovery?: {path: string[]; assumption: string}; result?: Result
}
type Deployment = {id: string; artifact: {application: string; release: string; source_agents: Record<string, string>}}

export function CompanyValidation() {
  const {principal} = useSession()
  const [runs, setRuns] = useState<Run[]>([]), [artifacts, setArtifacts] = useState<Deployment[]>([])
  const [artifact, setArtifact] = useState(''), [run, setRun] = useState<Run | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const canOperate = principal.role !== 'viewer'
  async function refresh() {
    try {
      const [jobs, deployments] = await Promise.all([
        api.get<Run[]>('/api/company/runs'), api.get<Deployment[]>('/api/company/artifacts')])
      setRuns(jobs); setArtifacts(deployments)
    } catch (e) { setError(message(e)) }
  }
  useEffect(() => {
    let active = true
    async function poll() {
      try {
        const [jobs, deployments, detail] = await Promise.all([
          api.get<Run[]>('/api/company/runs'), api.get<Deployment[]>('/api/company/artifacts'),
          run?.id ? api.get<Run>(`/api/company/runs/${run.id}`) : Promise.resolve(null)])
        if (active) { setRuns(jobs); setArtifacts(deployments); if (detail) setRun(detail) }
      } catch (e) { if (active) setError(message(e)) }
    }
    void poll()
    const timer = setInterval(() => void poll(), 5000)
    return () => { active = false; clearInterval(timer) }
  }, [run?.id])

  async function upload(file?: File) {
    if (!file) return
    setBusy(true); setError('')
    try {
      if (file.size > 64000) throw new Error('Deployment manifest exceeds 64 KB')
      const response = await api.post<{artifact_id: string}>('/api/company/artifacts', JSON.parse(await file.text()))
      setArtifact(response.artifact_id); await refresh()
    } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  async function queue() {
    setBusy(true); setError('')
    try {
      const response = await api.post<{run_id: string}>('/api/company/runs', {artifact_id: artifact})
      setRun(await api.get<Run>(`/api/company/runs/${response.run_id}`)); await refresh()
    } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  async function open(id: string) {
    try { setRun(await api.get<Run>(`/api/company/runs/${id}`)); setError('') }
    catch (e) { setError(message(e)) }
  }
  function download() {
    if (!run) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(run, null, 2)], {type: 'application/json'}))
    const link = document.createElement('a'); link.href = url; link.download = `company-run-${run.id}.json`; link.click()
    URL.revokeObjectURL(url)
  }
  const result = run?.result, patch = result?.hunter.patches.find(p => p.label === 'verified in the tested company twin')
    ?? result?.hunter.patches[0]
  const probes = result?.hunter.evidence.filter(e => e.tool === 'company_probe') ?? []

  return <>
    <div className="page-head"><div><span className="eyebrow"><Icon name="route" size={14}/>Connected application validation</span>
      <h1>Company attack and repair</h1><p>Discover a running application, reproduce its deployment, validate restricted-record access, and retest a candidate fix with legitimate workflows.</p></div>
      {canOperate && <label className="btn"><Icon name="upload" size={16}/>Import deployment<input type="file" accept=".json" className="sr-only" disabled={busy} onChange={e => void upload(e.target.files?.[0])}/></label>}
    </div>
    <div className="alert info"><Icon name="eye"/><span>The employee client is assumed compromised. This scenario tests a synthetic application's authorization path; it does not demonstrate initial laptop compromise.</span></div>
    {error && <div className="alert danger" role="alert">{error}</div>}
    <section className="card card-pad stack">
      <div className="row between"><div><b>Deployment artifacts</b><p className="muted">Same application images and declared network links, with synthetic accounts and records.</p></div></div>
      <div className="row"><select className="select" aria-label="Company deployment" value={artifact} onChange={e => setArtifact(e.target.value)}>
        <option value="">Select a deployment</option>{artifacts.map(a => <option key={a.id} value={a.id}>{a.artifact.application} {a.artifact.release} · {a.id.slice(0, 10)}</option>)}</select>
        {canOperate && <button className="btn primary" disabled={busy || !artifact} onClick={() => void queue()}>Validate on disposable copies</button>}
      </div>
      {!artifacts.length && <p className="muted">Import the company-records deployment manifest after enrolling its source agents. Admission requires fresh discovered workloads and all three observed connections.</p>}
    </section>
    <div className="grid-2 company-layout">
      <section className="card"><div className="card-head"><h2>Workspace runs</h2></div><div className="card-body stack">
        {!runs.length && <p className="muted">No company validation runs yet.</p>}
        {runs.map(r => <button className={`btn ${run?.id === r.id ? 'primary' : ''}`} key={r.id} onClick={() => void open(r.id)}>
          {r.id.slice(0, 8)} · {r.status}</button>)}
      </div></section>
      {!run ? <section className="card"><div className="empty"><Icon name="route"/><b>Select a validation run</b><span>The original path, executed evidence and candidate verification appear here.</span></div></section> :
        <section className="card"><div className="card-head"><div><h2>{run.status === 'completed' ? 'Attack and repair verified' : `Validation ${run.status}`}</h2><p className="mono">{run.id}</p></div>
          <button className="btn sm" onClick={download}><Icon name="download" size={14}/>Evidence JSON</button></div>
          <div className="card-body stack" style={{gap: 20}}>
            <div className="row" style={{flexWrap: 'wrap'}}>{['Employee client', 'Gateway', 'Internal API', 'Database'].map((name, i) => <span className="row" key={name}>
              {i > 0 && <span aria-hidden="true">→</span>}<span className="chip">{name}</span></span>)}</div>
            <p className="muted">Discovery: {run.discovery?.path.join(' → ') ?? 'waiting for source snapshot'}</p>
            {run.error && <div className="alert danger">Worker failed: {run.error}. No successful validation is claimed.</div>}
            {!result ? <p className="muted">{run.status === 'queued' ? 'Waiting for a configured company worker.' : 'Evidence appears after the worker finishes; this view refreshes automatically.'}</p> : <>
              <div className="row" style={{flexWrap: 'wrap'}}>
                <span className={`chip ${result.attack_path_confirmed ? 'danger' : 'warn'}`}>{result.attack_path_confirmed ? 'Original twin: restricted access confirmed' : 'Original twin: no confirmed path'}</span>
                <span className={`chip ${result.repair_verified ? 'ok' : 'warn'}`}>{result.repair_verified ? 'Candidate: repair verified' : 'Candidate: repair unverified'}</span>
                <span className="chip">Cleanup: {result.cleanup}</span>
              </div>
              <div><h3>Executed attack evidence</h3><Observations values={probes}/></div>
              {patch && <div className="stack"><h3>Proposed change and retest</h3>
                <p><b>{patch.change.component}</b>: {patch.change.field} <code>{patch.change.before}</code> → <code>{patch.change.after}</code></p>
                <div className={`alert ${patch.label === 'verified in the tested company twin' ? 'info' : 'danger'}`}>{patch.label}{patch.error ? ` · ${patch.error}` : ''}</div>
                {patch.security_retest && <Observations values={[patch.security_retest]}/>}
                <p><b>Legitimate workflows:</b> original {patch.original_workflows.passed ? 'passed' : 'failed'}; candidate {patch.candidate_workflows?.passed ? 'passed' : 'failed or unavailable'}.</p>
                {patch.candidate_workflows && <Observations values={patch.candidate_workflows.observations}/>}
                <p className="muted">Same application images: {patch.same_application_images ? 'verified' : 'unverified'} · candidate cleanup: {patch.candidate_cleanup ?? 'unverified'}. Source deployment is not modified.</p>
              </div>}
              <details><summary>Hunter decisions and executed observations · {result.hunter.trace_integrity.verified ? 'hash chain verified' : 'integrity failed'}</summary>
                <p className="muted">{result.hunter.model.requested_model ?? 'Model'} · status {result.hunter.status} · {result.hunter.reported_tokens ?? 'unreported'} tokens</p>
                <pre style={{maxHeight: 420, overflow: 'auto', whiteSpace: 'pre-wrap'}}>{JSON.stringify(result.hunter.trace, null, 2)}</pre></details>
              <p className="muted">{result.limitations.join(' ')}</p>
            </>}
          </div>
        </section>}
    </div>
  </>
}

function Observations({values}: {values: Observation[]}) {
  return <div className="table-wrap"><table className="table"><thead><tr><th>Actor</th><th>Record</th><th>HTTP</th><th>Gateway / API / DB evidence</th><th>Expected record returned</th></tr></thead>
    <tbody>{values.map(e => <tr key={e.request_id}><td>{e.actor}<div className="muted" style={{fontSize: 10}}>{e.client_context === 'trusted_gateway_workflow_probe' ? 'Trusted workflow probe' : e.client_context === 'compromised_employee' ? 'Employee client' : 'Context not recorded'}</div></td><td>{e.record}</td><td>{e.http_status}</td>
      <td>{e.chain_verified ? 'Correlated across the complete path' : 'Incomplete'}<div className="mono muted" style={{fontSize: 10}}>{e.request_id}</div></td><td>{e.returned_expected_record ? 'Yes' : 'No'}</td></tr>)}</tbody></table></div>
}
