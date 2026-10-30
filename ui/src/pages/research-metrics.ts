/** Mirrors ingestion/twin_ingestion/phase3/metrics.py so local files and saved runs report identical numbers. */
export type Row = {scenario_id: string; baseline: string; repetition: number; status: string; prediction: boolean | null; truth: boolean | null
  truth_verified: boolean; elapsed_seconds: number; evidence?: Record<string, unknown>[]; trace?: TraceEvent[]; snapshot_hash: string
  error?: string; path_kind?: string; reported_tokens?: number | null; assessment_kind?: string; cost_usd?: number | null}
export type TraceEvent = {index: number; kind: string; payload: Record<string, unknown>; hash: string; previous_hash?: string; at?: string}
export type Patch = {label: string; seeded_case?: string; source_snapshot?: string; candidate_snapshot?: string; diff?: string
  checks?: Record<string, unknown>; rollback?: unknown; error?: string; limitations?: string[]}
export type Report = {run_id: string; schema_version: string; mode: string; created_at: string; manifest_hash: string
  model_lock: Record<string, unknown>; environment: Record<string, unknown>; budgets?: Record<string, unknown>; rows: Row[]; patches: Patch[]; limitations: string[]}
export type BaselineSummary = {declared_runs: number; labeled_runs: number; conclusive_runs: number; tp: number; fp: number; tn: number; fn: number
  precision: number | null; recall_conclusive: number | null; recall_all_labeled: number | null; f1: number | null; false_positive_rate: number | null
  coverage: number | null; unsupported_rate: number | null; inconclusive_rate: number | null; unavailable_rate: number | null
  mean_detection_seconds: number | null; ai_tokens: number | null}

const ratio = (a: number, b: number) => b ? a / b : null

export function summarize(report: Report): Record<string, BaselineSummary> {
  const result: Record<string, BaselineSummary> = {}
  for (const baseline of [...new Set(report.rows.map(r => r.baseline))].sort()) {
    const rows = report.rows.filter(r => r.baseline === baseline)
    const labeled = rows.filter(r => r.truth_verified && typeof r.truth === 'boolean')
    const conclusive = labeled.filter(r => typeof r.prediction === 'boolean' && r.status === 'completed')
    const tp = conclusive.filter(r => r.prediction && r.truth).length, fp = conclusive.filter(r => r.prediction && !r.truth).length
    const tn = conclusive.filter(r => !r.prediction && !r.truth).length, fn = conclusive.filter(r => !r.prediction && r.truth).length
    const elapsed = rows.filter(r => r.status === 'completed').map(r => r.elapsed_seconds)
    result[baseline] = {declared_runs: rows.length, labeled_runs: labeled.length, conclusive_runs: conclusive.length, tp, fp, tn, fn,
      precision: ratio(tp, tp + fp), recall_conclusive: ratio(tp, tp + fn), recall_all_labeled: ratio(tp, labeled.filter(r => r.truth).length),
      f1: ratio(2 * tp, 2 * tp + fp + fn), false_positive_rate: ratio(fp, fp + tn), coverage: ratio(conclusive.length, labeled.length),
      unsupported_rate: ratio(rows.filter(r => r.status === 'unsupported').length, rows.length),
      inconclusive_rate: ratio(rows.filter(r => r.status === 'inconclusive' || r.status === 'error').length, rows.length),
      unavailable_rate: ratio(rows.filter(r => r.status === 'unavailable').length, rows.length),
      mean_detection_seconds: elapsed.length ? elapsed.reduce((a, b) => a + b, 0) / elapsed.length : null,
      ai_tokens: rows.some(r => r.reported_tokens != null) ? rows.reduce((a, r) => a + (r.reported_tokens ?? 0), 0) : null}
  }
  return result
}

export type Outcome = 'correct' | 'wrong' | 'abstain' | 'unavailable'
export function outcome(row: Row): Outcome {
  if (row.status === 'unavailable') return 'unavailable'
  if (row.status !== 'completed' || typeof row.prediction !== 'boolean' || !row.truth_verified || typeof row.truth !== 'boolean') return 'abstain'
  return row.prediction === row.truth ? 'correct' : 'wrong'
}

export const pct = (v: number | null | undefined) => v == null ? '—' : `${Math.round(v * 100)}%`
export const BASELINE_LABEL: Record<string, string> = {static_assessment: 'Static rules', default_twins: 'Default twins',
  synced_deterministic: 'Synced deterministic', synced_twinhunter: 'Synced TwinHunter'}

// ------------------------------------------------------------------ insights
// Mirrors ingestion/twin_ingestion/phase3/insights.py. Hash-chain verification
// runs only on the API; offline it is reported as not checked.
export type AgentBehaviour = {traced_runs: number; actions_total: number; actions_per_run: number | null
  tool_usage: Record<string, number>; blocked_reasons: Record<string, number>; finish_status: Record<string, number>; model_errors: number
  steps_to_conclusive_evidence: {mean: number | null; median: number | null; runs_without_conclusive_evidence: number}
  evidence_backed_positive_rate: number | null
  trace_integrity: {verified: number; checked: number; broken: {scenario_id: string; repetition: number; first_invalid: number}[]} | null}
export type Disagreement = {scenario_id: string; truth: boolean | null; kind: 'split' | 'all_wrong'; correct_methods: string[]
  methods: Record<string, {outcome: Outcome; outcomes: Record<string, number>; predictions: (boolean | null)[]}>}
export type Insights = {agent: Record<string, AgentBehaviour>; disagreements: Disagreement[]; patch_funnel: {stage: string; label: string; count: number}[]; definitions: string}

const count = (items: string[]) => Object.fromEntries([...items.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]))
const mode = (items: Outcome[]) => Object.entries(count(items))[0][0] as Outcome

export function localInsights(report: Report): Insights {
  const agent: Record<string, AgentBehaviour> = {}
  for (const b of [...new Set(report.rows.map(r => r.baseline))].sort()) {
    const rows = report.rows.filter(r => r.baseline === b), traced = rows.filter(r => r.trace?.length), events = traced.flatMap(r => r.trace!)
    const steps = traced.map(r => { let n = 0; for (const e of r.trace!) { if (e.kind === 'action') n++; else if (e.kind === 'observation' && ['confirmed', 'not_reproduced'].includes(String(e.payload.verdict))) return n } return null }).filter((x): x is number => x !== null)
    const sorted = [...steps].sort((x, y) => x - y), positives = rows.filter(r => r.prediction === true && r.status === 'completed')
    agent[b] = {traced_runs: traced.length, actions_total: events.filter(e => e.kind === 'action').length,
      actions_per_run: traced.length ? events.filter(e => e.kind === 'action').length / traced.length : null,
      tool_usage: count(events.filter(e => e.kind === 'action').map(e => String(e.payload.name ?? 'unknown'))),
      blocked_reasons: count(events.filter(e => e.kind === 'blocked').map(e => e.payload.status === 'duplicate' ? 'duplicate action' : String(e.payload.reason ?? 'blocked').slice(0, 80))),
      finish_status: count(traced.map(r => String([...r.trace!].reverse().find(e => e.kind === 'finished')?.payload.status ?? 'unfinished'))),
      model_errors: events.filter(e => e.kind === 'model_error').length,
      steps_to_conclusive_evidence: {mean: steps.length ? steps.reduce((x, y) => x + y, 0) / steps.length : null,
        median: sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null,
        runs_without_conclusive_evidence: traced.length - steps.length},
      evidence_backed_positive_rate: positives.length ? positives.filter(r => r.evidence?.length).length / positives.length : null, trace_integrity: null}
  }
  const disagreements: Disagreement[] = []
  for (const sc of [...new Set(report.rows.map(r => r.scenario_id))].sort()) {
    const group = report.rows.filter(r => r.scenario_id === sc), methods: Disagreement['methods'] = {}
    for (const b of [...new Set(group.map(r => r.baseline))].sort()) {
      const own = group.filter(r => r.baseline === b), outcomes = own.map(outcome)
      methods[b] = {outcome: mode(outcomes), outcomes: count(outcomes), predictions: own.map(r => r.prediction)}
    }
    const answered = Object.entries(methods).filter(([, m]) => m.outcome === 'correct' || m.outcome === 'wrong')
    const kinds = new Set(answered.map(([, m]) => m.outcome))
    const kind = kinds.size > 1 ? 'split' : answered.length && kinds.has('wrong') ? 'all_wrong' : null
    if (kind) disagreements.push({scenario_id: sc, truth: group.find(r => r.truth_verified)?.truth ?? null, kind, methods,
      correct_methods: answered.filter(([, m]) => m.outcome === 'correct').map(([b]) => b).sort()})
  }
  const stages: [string, string, (p: Patch) => boolean][] = [
    ['attempted', 'Candidate edits attempted', () => true],
    ['reproduced', 'Original weakness reproduced', p => (p.checks?.original_security as {verdict?: string} | undefined)?.verdict === 'confirmed'],
    ['original_workflow', 'Original workflow works', p => p.checks?.original_workflow === true],
    ['syntax_and_startup', 'Candidate starts cleanly', p => p.checks?.syntax_and_startup === true],
    ['security_fixed', 'Security retest no longer reproduces', p => (p.checks?.security_retest as {verdict?: string} | undefined)?.verdict === 'not_reproduced'],
    ['legitimate_workflow', 'Legitimate workflow preserved', p => p.checks?.legitimate_workflow === true],
    ['accepted', 'Verified in the tested twin scenario', p => p.label === 'verified in the tested twin scenario']]
  let survivors = report.patches
  const patch_funnel = stages.map(([stage, label, test]) => { survivors = survivors.filter(test); return {stage, label, count: survivors.length} })
  return {agent, disagreements, patch_funnel, definitions: 'Computed in the browser; trace hash chains are verified only by the API.'}
}
