import {useEffect, useMemo, useState} from 'react'
import {api, DEMO, message} from '../api'
import {useSession} from '../auth'
import {Icon} from '../ui/icons'
import {BASELINE_LABEL, localInsights, outcome, pct, summarize, type Insights, type Report, type Row, type TraceEvent} from './research-metrics'
import {ResearchInsights} from './ResearchInsights'

const download = (name: string, value: string, type = 'application/json') => {
  const url = URL.createObjectURL(new Blob([value], {type})), a = document.createElement('a')
  a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url)
}
const csvCell = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`
const TRACE_ICON: Record<string, string> = {hypothesis: 'spark', action: 'bolt', observation: 'eye', blocked: 'shield', model_error: 'alert', finished: 'check'}
const TRACE_TONE: Record<string, string> = {hypothesis: 'accent', action: 'info', observation: 'ok', blocked: 'danger', model_error: 'danger', finished: ''}

export function Research() {
  const {principal} = useSession()
  const [report, setReport] = useState<Report | null>(null), [saved, setSaved] = useState<{id: string; mode: string; created_at: string}[]>([])
  const [cell, setCell] = useState<{scenario: string; baseline: string} | null>(null), [note, setNote] = useState(''), [busy, setBusy] = useState(false)
  const [insights, setInsights] = useState<{value: Insights; source: 'api' | 'browser'} | null>(null)
  const canOperate = principal.role !== 'viewer'
  useEffect(() => { api.get<typeof saved>('/api/research/reports').then(setSaved).catch(() => setSaved([])) }, [])

  function load(value: Report, known?: Insights) {
    if (value.schema_version !== '3.0' || !Array.isArray(value.rows) || !Array.isArray(value.patches)) throw new Error('Not a Phase 3 report (schema 3.0)')
    setReport(value); setCell(null); setNote('')
    if (known) { setInsights({value: known, source: 'api'}); return }
    // Prefer the API (it also verifies trace hash chains); fall back to the browser mirror offline.
    setInsights({value: localInsights(value), source: 'browser'})
    api.post<{insights: Insights}>('/api/research/insights', value).then(r => setInsights({value: r.insights, source: 'api'})).catch(() => {})
  }
  async function open(file?: File) {
    if (!file) return
    try { if (file.size > 20_000_000) throw new Error('Report exceeds 20 MB'); load(JSON.parse(await file.text())) } catch (e) { setNote(message(e)) }
  }
  async function openSaved(id: string) {
    if (!id) return
    try { const r = await api.get<{report: Report; insights: Insights}>(`/api/research/reports/${id}`); load(r.report, r.insights) } catch (e) { setNote(message(e)) }
  }
  async function persist() {
    if (!report) return
    setBusy(true)
    try { await api.post('/api/research/reports', report); setNote('Saved to this workspace’s research history.'); setSaved(await api.get('/api/research/reports')) }
    catch (e) { setNote(message(e)) } finally { setBusy(false) }
  }
  function exportCsv() {
    if (!report) return
    const fields = ['scenario_id', 'baseline', 'repetition', 'status', 'prediction', 'truth', 'truth_verified', 'elapsed_seconds', 'reported_tokens'] as const
    download('research-results.csv', [fields.join(','), ...report.rows.map(r => fields.map(k => csvCell(r[k])).join(','))].join('\n'), 'text/csv')
  }

  const summary = useMemo(() => report ? summarize(report) : {}, [report])
  const baselines = Object.keys(summary)
  const scenarios = useMemo(() => report ? [...new Set(report.rows.map(r => r.scenario_id))].sort() : [], [report])
  const cellRows = report && cell ? report.rows.filter(r => r.scenario_id === cell.scenario && r.baseline === cell.baseline) : []

  return <>
    <div className="page-head">
      <div><span className="eyebrow"><Icon name="spark" size={14}/>Phase 3 · bounded AI hunting</span><h1>TwinHunter research</h1>
        <p>Compare static rules, default twins, synchronized deterministic twins and the TwinHunter agent on the same declared scenarios. Model hypotheses stay separate from executed observations; patches are verified only on disposable twins.</p></div>
      <div className="row">
        {saved.length > 0 && <select className="select" aria-label="Saved research run" defaultValue="" onChange={e => void openSaved(e.target.value)}>
          <option value="" disabled>Saved runs · {saved.length}</option>{saved.map(r => <option key={r.id} value={r.id}>{r.id.slice(0, 8)} · {r.mode}</option>)}</select>}
        <label className="btn"><Icon name="upload" size={16}/>Open report<input type="file" accept=".json" className="sr-only" onChange={e => void open(e.target.files?.[0])}/></label>
      </div>
    </div>
    {note && <div className="alert info" role="status"><Icon name="file"/>{note}</div>}

    {!report ? <section className="card"><div className="empty" style={{padding: 64}}><Icon name="spark"/><b>No report loaded</b>
      <span>Open <code>research/results/repeated/report.json</code>{DEMO ? '' : ' or pick a saved run'} to inspect measured results, including unavailable model runs.</span></div></section> : <>
      <section className="card card-pad row between">
        <div><b>{report.mode.replaceAll('_', ' ')}</b> <span className="muted">· {report.rows.length} records · {scenarios.length} scenarios · created {new Date(report.created_at).toLocaleString()}</span>
          <div className="mono muted" style={{fontSize: 11.5}}>run {report.run_id} · manifest {report.manifest_hash.slice(0, 16)}…</div></div>
        <div className="row"><button className="btn sm" onClick={exportCsv}><Icon name="download" size={14}/>CSV</button>
          <button className="btn sm" onClick={() => download('report.json', JSON.stringify(report, null, 2))}><Icon name="download" size={14}/>JSON</button>
          {canOperate && <button className="btn primary sm" disabled={busy} onClick={() => void persist()}><Icon name="upload" size={14}/>Save to workspace</button>}</div>
      </section>

      <section className="grid-3" style={{gridTemplateColumns: `repeat(${Math.min(4, baselines.length)}, minmax(0, 1fr))`}} aria-label="Method comparison">
        {baselines.map(b => { const s = summary[b], hunter = b === 'synced_twinhunter'
          return <article key={b} className="card card-pad stack" style={{gap: 12, borderColor: hunter ? '#c7d2fe' : undefined}}>
            <div className="row between"><b>{BASELINE_LABEL[b] ?? b}</b>{hunter && <span className="chip accent"><Icon name="spark" size={12}/>AI</span>}</div>
            {[['Precision', s.precision], ['Recall', s.recall_conclusive], ['F1', s.f1], ['Coverage', s.coverage]].map(([label, value]) =>
              <div key={String(label)}><div className="row between" style={{fontSize: 12.5}}><span className="muted">{label}</span><b>{pct(value as number | null)}</b></div>
                <div className="bar" style={{marginTop: 4}}><span style={{width: `${((value as number | null) ?? 0) * 100}%`, background: label === 'Coverage' ? 'var(--observed)' : undefined}}/></div></div>)}
            <div className="row" style={{gap: 6}}><span className="chip ok">TP {s.tp}</span><span className="chip danger">FP {s.fp}</span><span className="chip">TN {s.tn}</span><span className="chip warn">FN {s.fn}</span></div>
            <small className="muted">{s.conclusive_runs}/{s.labeled_runs} conclusive · {pct(s.unavailable_rate)} unavailable · {pct(s.unsupported_rate)} unsupported{s.ai_tokens != null ? ` · ${s.ai_tokens.toLocaleString()} tokens` : ''}</small>
          </article> })}
      </section>

      {insights && <ResearchInsights insights={insights.value} source={insights.source} onScenario={(scenario, baseline) => setCell({scenario, baseline})}/>}

      <div className="grid-2">
        <section className="card" aria-label="Scenario matrix">
          <div className="card-head"><div><h2>Scenario × method</h2><p>Each cell aggregates repetitions; click to inspect evidence and the AI trace</p></div>
            <div className="legend-row"><span><i style={{background: 'var(--ok)'}}/>Correct</span><span><i style={{background: 'var(--danger)'}}/>Wrong</span><span><i style={{background: 'var(--warn)'}}/>Abstained</span><span><i style={{background: 'var(--faint)'}}/>Unavailable</span></div></div>
          <div className="table-wrap"><table className="table"><thead><tr><th>Scenario</th>{baselines.map(b => <th key={b}>{BASELINE_LABEL[b] ?? b}</th>)}</tr></thead>
            <tbody>{scenarios.map(sc => <tr key={sc}><td className="mono"><b>{sc}</b></td>{baselines.map(b => {
              const rows = report.rows.filter(r => r.scenario_id === sc && r.baseline === b), outcomes = rows.map(outcome)
              const on = cell?.scenario === sc && cell.baseline === b
              return <td key={b} style={{padding: '6px 20px'}}><button aria-label={`${sc} ${b}`} onClick={() => setCell({scenario: sc, baseline: b})}
                style={{display: 'flex', gap: 3, padding: 4, border: on ? '2px solid var(--accent)' : '2px solid transparent', borderRadius: 7, background: 'none', cursor: 'pointer'}}>
                {outcomes.map((o, i) => <span key={i} style={{width: 14, height: 18, borderRadius: 4, background: {correct: 'var(--ok)', wrong: 'var(--danger)', abstain: 'var(--warn)', unavailable: '#cbd5e1'}[o]}}/>)}
              </button></td> })}</tr>)}</tbody></table></div>
        </section>

        <section className="card" aria-label="Cell detail" style={{position: 'sticky', top: 84}}>
          {!cell ? <div className="empty"><Icon name="eye"/><b>Select a cell</b><span>Evidence, predictions and the hash-chained AI trace appear here.</span></div> : <>
            <div className="card-head"><div><h2>{cell.scenario} · {BASELINE_LABEL[cell.baseline] ?? cell.baseline}</h2><p>{cellRows.length} repetition{cellRows.length === 1 ? '' : 's'}</p></div>
              <button className="icon-btn" aria-label="Close detail" onClick={() => setCell(null)}><Icon name="x" size={16}/></button></div>
            <div className="card-body stack" style={{gap: 14, maxHeight: '70vh', overflow: 'auto'}}>{cellRows.map(r => <RowDetail key={r.repetition} row={r}/>)}</div>
          </>}
        </section>
      </div>

      <section className="card" aria-label="Patch verification">
        <div className="card-head"><div><h2>Patch verification · {report.patches.length}</h2><p>Candidate edits applied to disposable copies: original behavior, workflow, syntax/startup, security retest and candidate workflow</p></div></div>
        {report.patches.length === 0 ? <div className="empty"><b>No patch verification recorded</b></div> :
          <div className="card-body grid-3" style={{gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 14}}>{report.patches.map((p, i) => {
            const accepted = p.label === 'verified in the tested twin scenario'
            return <article key={i} className="wave-card">
              <div className="row between"><b>{p.seeded_case ?? `Candidate ${i + 1}`}</b><span className={`chip ${accepted ? 'ok' : 'danger'}`}>{accepted ? 'verified in twin' : p.label}</span></div>
              {p.error && <small className="muted">{p.error}</small>}
              <div className="row" style={{gap: 5}}>{Object.entries(p.checks ?? {}).map(([k, v]) => {
                // Boolean checks pass/fail; security checks carry a verdict ("not_reproduced" after a fix is the pass).
                const verdict = typeof v === 'object' && v ? String((v as {verdict?: string}).verdict ?? '') : ''
                const ok = typeof v === 'boolean' ? v : k === 'original_security' ? verdict === 'confirmed' : verdict === 'not_reproduced'
                if (typeof v !== 'boolean' && !verdict) return null
                return <span key={k} className={`chip ${ok ? 'ok' : 'danger'}`} title={verdict || undefined}><Icon name={ok ? 'check' : 'x'} size={11}/>{k.replaceAll('_', ' ')}{verdict ? `: ${verdict.replaceAll('_', ' ')}` : ''}</span> })}</div>
              {p.diff && <pre className="code diff">{p.diff}</pre>}
              <button className="btn sm" onClick={() => download(`rollback-${i}.json`, JSON.stringify(p.rollback, null, 2))}><Icon name="download" size={14}/>Rollback artifact</button>
            </article> })}</div>}
      </section>

      <details className="disclosure card"><summary>Model lock, environment and stated limitations</summary><div>
        <ul style={{margin: '0 0 12px', paddingLeft: 18, fontSize: 13, color: 'var(--text-2)'}}>{report.limitations.map(l => <li key={l}>{l}</li>)}</ul>
        <pre className="code">{JSON.stringify({model: report.model_lock, environment: report.environment, budgets: report.budgets}, null, 2)}</pre></div></details>
    </>}
  </>
}

function RowDetail({row}: {row: Row}) {
  const o = outcome(row)
  return <div className="stack" style={{gap: 10}}>
    <div className="row between"><b>Repetition {row.repetition}</b>
      <span className={`chip ${o === 'correct' ? 'ok' : o === 'wrong' ? 'danger' : o === 'abstain' ? 'warn' : ''}`}>{o}</span></div>
    <div className="row" style={{gap: 6, fontSize: 12.5}}><span className="chip">status {row.status}</span>
      <span className="chip">predicted {String(row.prediction ?? 'none')}</span><span className="chip">truth {row.truth_verified ? String(row.truth) : 'unverified'}</span>
      <span className="chip">{row.elapsed_seconds.toFixed(2)}s</span></div>
    {(row.error || row.path_kind || row.assessment_kind) && <small className="muted">{row.error ?? row.path_kind ?? row.assessment_kind?.replaceAll('_', ' ')}</small>}
    <div><h4 style={{fontSize: 12.5, marginBottom: 6}}>Executed evidence · {row.evidence?.length ?? 0}</h4>
      {row.evidence?.length ? row.evidence.map((e, i) => <details key={i} className="disclosure" style={{marginBottom: 6}}>
        <summary>{String(e.tool ?? 'observation')} · {String(e.verdict ?? 'observed')}</summary><div><pre className="code">{JSON.stringify(e, null, 2)}</pre></div></details>)
        : <small className="muted">No executed evidence. Model text alone never confirms a finding.</small>}</div>
    <div><h4 style={{fontSize: 12.5, marginBottom: 6}}>AI action trace · {row.trace?.length ?? 0}</h4>
      {row.trace?.length ? <ol className="timeline">{row.trace.map(e => <TraceItem key={e.index} event={e}/>)}</ol>
        : <small className="muted">No AI trace. An unavailable model is recorded as unavailable, never as success.</small>}</div>
  </div>
}

function TraceItem({event}: {event: TraceEvent}) {
  const text = event.kind === 'hypothesis' ? String(event.payload.text ?? '') : event.kind === 'action' ? `${event.payload.name} → ${event.payload.target_id}:${event.payload.port}`
    : event.kind === 'blocked' ? String(event.payload.reason ?? 'blocked') : event.kind === 'finished' ? `finished: ${event.payload.status}` : ''
  return <li className={event.kind === 'blocked' || event.kind === 'model_error' ? 'blocked' : 'done'}><span className="node"/>
    <div className="row" style={{gap: 6}}><span className={`chip ${TRACE_TONE[event.kind] ?? ''}`}><Icon name={TRACE_ICON[event.kind] ?? 'file'} size={11}/>{event.kind}</span>
      <span className="mono muted" style={{fontSize: 10.5}}>#{event.index} · {event.hash.slice(0, 10)}</span></div>
    {text && <small style={{color: 'var(--text-2)', marginTop: 3}}>{text}</small>}
    {(event.kind === 'observation' || event.kind === 'model_error') && <details className="disclosure" style={{marginTop: 6}}><summary>Payload</summary><div><pre className="code">{JSON.stringify(event.payload, null, 2)}</pre></div></details>}
  </li>
}
