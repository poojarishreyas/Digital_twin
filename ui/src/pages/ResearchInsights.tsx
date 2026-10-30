import {Icon} from '../ui/icons'
import {BASELINE_LABEL, pct, type Insights} from './research-metrics'

const OUTCOME_COLOR: Record<string, string> = {correct: 'var(--ok)', wrong: 'var(--danger)', abstain: 'var(--warn)', unavailable: '#cbd5e1'}

export function ResearchInsights({insights, source, onScenario}: {insights: Insights; source: 'api' | 'browser'; onScenario: (scenario: string, baseline: string) => void}) {
  const agents = Object.entries(insights.agent).filter(([, a]) => a.traced_runs > 0)
  const funnelMax = Math.max(1, insights.patch_funnel[0]?.count ?? 1)
  const baselines = Object.keys(insights.agent)
  return <>
    <section className="card" aria-label="Agent behaviour">
      <div className="card-head"><div><h2>Agent behaviour</h2><p>How hunting agents spent their bounded budget — derived from hash-chained action traces</p></div>
        <span className={`chip ${source === 'api' ? 'ok' : ''}`}><Icon name={source === 'api' ? 'shieldCheck' : 'eye'} size={12}/>{source === 'api' ? 'verified by API' : 'computed in browser'}</span></div>
      {agents.length === 0 ? <div className="empty"><Icon name="spark"/><b>No AI action traces in this report</b>
        <span>The model was unavailable or not part of this run. Nothing about agent behaviour is inferred from missing traces.</span></div> :
        <div className="card-body grid-3" style={{gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16}}>{agents.map(([baseline, a]) => {
          const tools = Object.entries(a.tool_usage), top = Math.max(1, ...tools.map(([, n]) => n))
          return <article key={baseline} className="wave-card" style={{gap: 12}}>
            <div className="row between"><b>{BASELINE_LABEL[baseline] ?? baseline}</b><span className="chip">{a.traced_runs} traced runs</span></div>
            <div className="row" style={{gap: 18}}>
              <div><strong style={{fontSize: 22}}>{a.actions_per_run?.toFixed(1) ?? '—'}</strong><small className="muted" style={{display: 'block', fontSize: 11.5}}>actions / run</small></div>
              <div><strong style={{fontSize: 22}}>{a.steps_to_conclusive_evidence.median ?? '—'}</strong><small className="muted" style={{display: 'block', fontSize: 11.5}}>median steps to evidence</small></div>
              <div><strong style={{fontSize: 22}}>{pct(a.evidence_backed_positive_rate)}</strong><small className="muted" style={{display: 'block', fontSize: 11.5}}>positives with evidence</small></div>
            </div>
            <div className="stack" style={{gap: 6}}>{tools.map(([tool, n]) => <div key={tool}>
              <div className="row between" style={{fontSize: 12}}><span className="mono">{tool}</span><span className="muted">{n}</span></div>
              <div className="bar"><span style={{width: `${(n / top) * 100}%`}}/></div></div>)}</div>
            {Object.keys(a.blocked_reasons).length > 0 && <div><small className="muted">Blocked by the executor</small>
              <div className="row" style={{gap: 5, marginTop: 4}}>{Object.entries(a.blocked_reasons).map(([reason, n]) => <span key={reason} className="chip danger" title={reason}>{reason.length > 34 ? reason.slice(0, 33) + '…' : reason} · {n}</span>)}</div></div>}
            <div className="row" style={{gap: 5}}>{Object.entries(a.finish_status).map(([status, n]) => <span key={status} className={`chip ${status === 'completed' ? 'ok' : status.endsWith('limit') ? 'warn' : 'danger'}`}>{status.replaceAll('_', ' ')} · {n}</span>)}
              {a.model_errors > 0 && <span className="chip danger">{a.model_errors} model errors</span>}</div>
            {a.trace_integrity ? <span className={`chip ${a.trace_integrity.broken.length ? 'danger' : 'ok'}`} style={{alignSelf: 'flex-start'}}><Icon name={a.trace_integrity.broken.length ? 'alert' : 'lock'} size={11}/>
              hash chain {a.trace_integrity.verified}/{a.trace_integrity.checked} intact</span>
              : <span className="chip" style={{alignSelf: 'flex-start'}}><Icon name="lock" size={11}/>hash chain not checked offline</span>}
          </article> })}</div>}
    </section>

    <div className="grid-2" style={{gridTemplateColumns: 'minmax(0, 1fr) 420px'}}>
      <section className="card" aria-label="Method disagreements">
        <div className="card-head"><div><h2>Where methods disagree · {insights.disagreements.length}</h2><p>Scenarios where answering methods split, or all answered wrongly. Abstentions never count as correct.</p></div></div>
        {insights.disagreements.length === 0 ? <div className="empty"><Icon name="check"/><b>All answering methods agree</b></div> :
          <div className="table-wrap" style={{maxHeight: 420}}><table className="table"><thead><tr><th>Scenario</th><th>Truth</th>{baselines.map(b => <th key={b}>{BASELINE_LABEL[b] ?? b}</th>)}<th>Kind</th></tr></thead>
            <tbody>{insights.disagreements.map(d => <tr key={d.scenario_id}>
              <td className="mono"><b>{d.scenario_id}</b></td><td>{d.truth == null ? <span className="muted">unlabeled</span> : <span className={`chip ${d.truth ? 'danger' : 'ok'}`}>{d.truth ? 'weak' : 'safe'}</span>}</td>
              {baselines.map(b => { const m = d.methods[b]; return <td key={b}>{m ? <button className="row" style={{gap: 6, border: 0, background: 'none', cursor: 'pointer', padding: 0}} onClick={() => onScenario(d.scenario_id, b)}>
                <span style={{width: 10, height: 10, borderRadius: 3, background: OUTCOME_COLOR[m.outcome]}}/><span style={{fontSize: 12.5}}>{m.outcome}</span></button> : '—'}</td> })}
              <td><span className={`chip ${d.kind === 'all_wrong' ? 'danger' : 'warn'}`}>{d.kind === 'all_wrong' ? 'all wrong' : 'split'}</span></td></tr>)}</tbody></table></div>}
      </section>

      <section className="card" aria-label="Patch funnel">
        <div className="card-head"><div><h2>Remediation funnel</h2><p>Each candidate must pass every stage on a disposable twin</p></div><Icon name="wrench"/></div>
        <div className="card-body stack" style={{gap: 10}}>{insights.patch_funnel.map((s, i) => <div key={s.stage}>
          <div className="row between" style={{fontSize: 12.5}}><span>{i + 1}. {s.label}</span><b>{s.count}</b></div>
          <div style={{height: 22, borderRadius: 7, background: 'var(--surface-3)', marginTop: 4, display: 'flex', justifyContent: 'center', overflow: 'hidden'}}>
            <span style={{width: `${(s.count / funnelMax) * 100}%`, borderRadius: 7, transition: 'width .4s',
              background: s.stage === 'accepted' ? 'var(--ok)' : `color-mix(in srgb, var(--accent) ${100 - i * 10}%, #c7d2fe)`}}/></div>
        </div>)}
          <small className="muted">Accepted means “verified in the tested twin scenario” — never a production compatibility claim.</small></div>
      </section>
    </div>
  </>
}
