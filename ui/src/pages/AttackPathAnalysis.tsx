import type {Assessment, Topology} from '../types'
import {Icon} from '../ui/icons'
import {analyzeFinding, hopEvidence, reportData, reportMarkdown, type Analysis, type ScanReport} from './attack-path-report'

function saveReport(scan: ScanReport, fixed: string[], format: 'md' | 'json') {
  const value = format === 'md' ? reportMarkdown(scan, fixed) : JSON.stringify(reportData(scan, fixed), null, 2)
  const url = URL.createObjectURL(new Blob([value], {type: format === 'md' ? 'text/markdown;charset=utf-8' : 'application/json'}))
  const link = document.createElement('a')
  link.href = url; link.download = `${scan.id}-analysis.${format}`; link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function AnalysisReportActions({scan, fixed}: {scan: ScanReport; fixed: string[]}) {
  return <div className="row">
    <button className="btn sm" onClick={() => saveReport(scan, fixed, 'md')}><Icon name="download" size={14}/>Download report</button>
    <button className="btn sm" onClick={() => saveReport(scan, fixed, 'json')}><Icon name="file" size={14}/>JSON</button>
  </div>
}

export function FindingAnalysis({route, topology, analysis, fixed}: {route: Assessment; topology: Topology; analysis: Analysis; fixed: boolean}) {
  const hops = hopEvidence(route, topology)
  return <details className="disclosure finding-analysis">
    <summary><Icon name="file" size={15}/>View detailed analysis report</summary>
    <div className="stack">
      <div className="report-metadata">
        <div><small>Finding ID</small><b className="mono">{analysis.id}</b></div>
        <div><small>Assessment basis</small><b>Source review + topology</b></div>
        <div><small>State</small><b>{fixed ? 'Remediated in simulation' : 'Live validation pending'}</b></div>
        <div><small>Classification</small><b>{analysis.classification}</b></div>
      </div>
      <p className="report-basis">{analysis.basis}</p>
      <section><h4>Executive analysis</h4><p>{analysis.summary}</p></section>
      <section><h4>Root cause</h4><p>{analysis.rootCause}</p></section>
      <div className="report-columns">
        <section><h4>Business impact</h4><ul>{analysis.impact.map(value => <li key={value}>{value}</li>)}</ul></section>
        <section><h4>Required conditions</h4><ul>{analysis.prerequisites.map(value => <li key={value}>{value}</li>)}</ul></section>
      </div>
      <section><h4>Source evidence</h4><div className="report-evidence">{analysis.evidence.map(value => <div key={value.label}>
        <b>{value.label}</b><p>{value.detail}</p><small>{value.source}</small>
      </div>)}</div></section>
      <section><h4>Hop-by-hop topology evidence</h4><div className="table-wrap"><table className="table report-table">
        <thead><tr><th>Hop</th><th>Evidence</th><th>Observation</th></tr></thead>
        <tbody>{hops.map((hop, index) => <tr key={index}><td><b>{hop.from} → {hop.to}</b></td>
          <td>{hop.kind === 'OBSERVED_CONNECTION' ? 'Observed connection' : hop.kind === 'INFERRED_REACHABILITY' ? 'Inferred reachability' : 'Evidence not recorded'}<small>{hop.source}</small>{hop.confirmed && <small><b>Confirmed in sandbox</b> · {hop.confirmation?.evidence_source ?? 'Source not recorded'} · {hop.confirmation?.basis.join(', ')}</small>}</td>
          <td>{hop.observedAt ? new Date(hop.observedAt).toLocaleString() : 'Time not recorded'}<small>Freshness: {hop.freshness}</small></td></tr>)}</tbody>
      </table></div></section>
      {route.remediation && <section className="report-basis"><h4>Sandbox repair evidence · {route.remediation.service}</h4><p>Change: {route.remediation.change}</p><p>Retest: {route.remediation.retest}</p><p>Normal workflows: {route.remediation.workflows}</p></section>}
      {route.issues.length > 0 && <section><h4>Evidence gaps</h4><ul>{route.issues.map((issue, index) => <li key={index}>{issue.asset_id}: {issue.reason.replaceAll('_', ' ')}{issue.gap_count ? ` (${issue.gap_count} gaps)` : ''}</li>)}</ul></section>}
      <section><h4>Remediation plan</h4><ol>{analysis.remediation.map(value => <li key={value}>{value}</li>)}</ol></section>
      <section><div className="row between"><h4>Verification plan</h4><span className="chip">Not executed</span></div><ul>{analysis.validation.map(value => <li key={value}>{value}</li>)}</ul></section>
      <div className="report-columns"><section><h4>Detection guidance</h4><p>{analysis.detection}</p></section><section><h4>Rollback considerations</h4><p>{analysis.rollback}</p></section></div>
      {analysis.related.length > 0 && <section><h4>Related hardening observations</h4><ul>{analysis.related.map(value => <li key={value}>{value}</li>)}</ul></section>}
      <section className="report-basis"><h4>Limits of the conclusion</h4><p>{analysis.limitation}</p></section>
      <section><h4>Research references</h4><ul className="report-references">{analysis.references.map(value => <li key={value.url}><a href={value.url} target="_blank" rel="noreferrer">{value.title} ↗</a></li>)}</ul></section>
    </div>
  </details>
}

export {analyzeFinding}
