import type {Assessment, Topology} from '../types'
import type {CodebaseSnapshot} from '../codebase'

export type Reference = {title: string; url: string}
export type Analysis = {
  id: string; title: string; severity: 'High' | 'Needs validation'; category: string; classification: string
  controlAssetId: string
  service: string; basis: string; summary: string; rootCause: string; impact: string[]; prerequisites: string[]
  evidence: {label: string; detail: string; source: string}[]
  remediation: string[]; validation: string[]; detection: string; rollback: string; limitation: string
  related: string[]; references: Reference[]
}
export type ScanReport = {
  id: string; capturedAt: string; routes: Assessment[]; topology: Topology; total: number; truncated: boolean
  codebase?: CodebaseSnapshot
}

export const assetLabel = (topology: Topology, id: string) => String(topology.nodes.find(node => node.id === id)?.properties.hostname ?? id)
const CWE = {title: 'MITRE CWE-306 · Missing authentication', url: 'https://cwe.mitre.org/data/definitions/306.html'}
const OWASP = {title: 'OWASP API1:2023 · Object-level authorization', url: 'https://api-security.owasp.org/editions/2023/en/0xa1-broken-object-level-authorization/'}
const REDIS = {title: 'Redis · Network security and authentication', url: 'https://redis.io/docs/latest/operate/oss_and_stack/management/security/'}
const ACL = {title: 'Redis · Access control lists', url: 'https://redis.io/docs/latest/operate/oss_and_stack/management/security/acl/'}
const SEGMENTATION = {title: 'MITRE ATT&CK · Network segmentation', url: 'https://attack.mitre.org/mitigations/M1030/'}

export function analyzeFinding(route: Assessment, topology: Topology, codebase?: CodebaseSnapshot): Analysis {
  const names = route.nodes.map(id => assetLabel(topology, id))
  const target = names.at(-1) ?? 'critical asset'
  // A known fixture selects a researched scenario, never a claim about live
  // configuration. Other workspaces get a connectivity assessment instead.
  const shop = names[0] === 'shop-web01' && target === 'shop-db01' && names.some(name => name === 'shop-app01' || name === 'shop-orders01')
  if (codebase) return {
    id: `TH-AUTH-${codebase.commit.slice(0, 12)}`, title: 'Unauthenticated order-history API exposes cross-customer orders',
    severity: 'High', category: 'Authentication and data access', classification: 'CWE-306 · Missing authentication',
    controlAssetId: route.nodes[1] ?? route.nodes[0], service: 'app.py · list_orders() · GET /orders',
    basis: `Repository source verified at ${codebase.commit}. Mapping this repository to running hosts is not yet verified.`,
    summary: `The connected repository ${codebase.slug} contains the supported vulnerable list_orders() implementation. It returns synthetic orders for every customer without calling the existing identity provider. The displayed topology is context, not proof that this repository is deployed on those hosts.`,
    rootCause: 'list_orders(headers) returns the global ORDERS collection without authenticating the caller or checking ownership. auth.py already provides the fixture identity lookup, but the handler does not use it.',
    impact: ['Anonymous callers can read all three synthetic lab orders, including customer identifiers, amounts and order status.', 'The lab contains no real customer data or database credentials. This finding does not establish compromise of the running AWS shop.'],
    prerequisites: ['This exact code must be running and its HTTP endpoint reachable for the source issue to be exploitable.', 'The GitHub source snapshot is verified; runtime reachability and deployment correspondence have not been tested.'],
    evidence: [{label: 'Pinned repository file', detail: `${codebase.url}/blob/${codebase.commit}/app.py matches the supported vulnerable lab implementation.`, source: 'GitHub contents API · immutable commit'},
      {label: 'Missing identity and ownership checks', detail: 'list_orders() directly returns ORDERS. The response is neither authenticated nor filtered by customer_id.', source: 'app.py · list_orders()'},
      {label: 'Existing identity provider', detail: 'auth.py matches the supported fixture provider, including customer and support roles.', source: 'auth.py · authenticate()'},
      {label: 'Runtime validation', detail: 'Repository code was not executed on the control plane. Run the included security tests on a local or isolated candidate.', source: 'Not executed'}],
    remediation: ['Authenticate the request and return HTTP 401 for missing or invalid credentials.', 'Filter orders by the server-derived customer identity; allow cross-customer listings only for the support role.', 'Create a pull request on a separate branch. Review and test before merging; deploy separately after the default branch is verified.'],
    validation: ['Run python -m unittest test_security -v on the candidate; all six tests should pass.', 'Verify anonymous/invalid identities are denied, both customers see only their own orders, and the support listing still works.', 'Merge the PR, refresh source, and run analysis again. A pending PR does not resolve the default-branch finding.'],
    detection: 'For a real deployment, log authorization decisions and request IDs, and alert on unexpected access to another customer’s orders.',
    rollback: 'Keep the prior application revision. If the candidate fails legitimate workflows, reject the PR and repair it before deployment.',
    limitation: 'Only the supplied lab source snapshots are supported for automatic repair. No LLM or live exploit is executed. A created PR is a real proposed code change; it is not automatically merged, tested in GitHub, or deployed to AWS.',
    related: [], references: [CWE, OWASP],
  }
  const common = {
    id: `TH-${shop ? 'AUTH' : 'NET'}-${route.id.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 24)}`,
    basis: shop ? 'Deployment-source scenario matched by fixture hostnames; live exploitability unverified.' : 'Topology evidence only; live security controls and exploitability unverified.',
    limitation: 'The frontend does not execute HTTP probes, authenticate to services, inspect live configuration or call an LLM. Red route animations show connectivity, not proof that each hop can be exploited. Fix and retest outcomes are simulated. No CVE is assigned and no CVSS score is asserted.',
  }
  if (shop) return {
    ...common,
    title: 'Unauthenticated order-history API exposes cross-customer orders', severity: 'High',
    controlAssetId: route.nodes[names.indexOf('shop-orders01') >= 0 ? names.indexOf('shop-orders01') : names.indexOf('shop-app01')],
    category: 'Authentication and data access', classification: 'CWE-306 · Missing authentication',
    service: 'Orders API · GET /api/orders/orders · upstream TCP 8083',
    summary: `In the supplied shop deployment, ${names[0]} proxies order-history requests to the orders service. The handler queries recent orders from ${target} without identifying the caller or restricting results to that customer's records. If the deployed configuration matches the fixture, a caller who can reach the storefront could read order metadata belonging to other customers.`,
    rootCause: 'The shared request dispatcher invokes handlers without authentication. The order-history handler performs a global recent-orders query with no principal or ownership filter. Reverse proxying and database password authentication do not supply the missing application authorization check.',
    impact: [
      'Potential disclosure of order identifiers, customer identifiers, amounts and payment status across customers.',
      'Confidentiality impact is scoped to the returned order metadata. The source query returns up to ten recent orders per request.',
      'This finding does not establish database credential theft, arbitrary SQL access, a customer-table dump, payment-card disclosure or remote code execution.',
    ],
    prerequisites: [
      'The running storefront and orders service must match the supplied deployment source.',
      'The caller must be able to reach the storefront; the lab security group restricts public access to the configured operator network.',
      'No additional identity or authorization control may be enforcing access before the request reaches this handler.',
    ],
    evidence: [
      {label: 'Unauthenticated dispatch', detail: 'serve() dispatches matching GET handlers without validating an identity or session.', source: 'Repository review · deploy/aws/ecommerce/shop_service.py · serve()'},
      {label: 'Global order-history query', detail: 'orders().recent() selects order_id, customer_id, total_cents and status, ordered by creation time, with LIMIT 10 and no customer filter.', source: 'Repository review · deploy/aws/ecommerce/shop_service.py · orders()'},
      {label: 'Reachable proxy route in the fixture', detail: 'The /api/orders/ location forwards to the orders upstream; /api/orders/orders reaches the /orders handler.', source: 'Repository review · deploy/aws/ecommerce/host-setup.sh · web configuration'},
      {label: 'Current runtime confirmation', detail: 'No live request or data-access test was performed by this scan. A response body, HTTP verdict and request correlation ID are not available.', source: 'Execution status · not tested'},
    ],
    remediation: [
      'Require an authenticated identity before dispatching order-history requests; reject anonymous requests with HTTP 401.',
      'Scope database reads to the authenticated customer. Derive customer identity on the server, rather than trusting a client-supplied customer_id.',
      'Use a separate staff capability for cross-customer listings and deny unauthorized callers with HTTP 403.',
      'Keep parameterized SQL and grant the service account only the required database permissions. Preserve legitimate orders and catalog traffic.',
    ],
    validation: [
      'Anonymous order-history request: expect HTTP 401 and no order records.',
      'Customer A session: return only A’s synthetic orders. Attempt access to customer B’s records: deny with no B data.',
      'Authorized staff session: allow the scoped support workflow; an ordinary customer cannot invoke a staff listing.',
      'Regression: catalog browsing, cart operations and authorized checkout continue to work. Correlate gateway, API and database evidence on an isolated copy.',
    ],
    detection: 'Alert on unauthenticated access to order-history routes, unexpected cross-customer reads and unusual listing volume. Record principal, authorization decision and request ID without logging full order payloads or credentials.',
    rollback: 'Retain the prior application image and configuration before a real rollout. Roll back a faulty candidate in an isolated copy; if access control must be withdrawn in production, disable the affected route until a working control is restored.',
    related: [
      'The shop setup also configures Redis to listen on all interfaces with protected mode disabled and no added password. Its security-group template permits TCP 6379 inside the VPC. Treat this as a separate source-based hardening concern, not a proven database pivot.',
      'For a real Redis remediation, restrict the listener and allowed clients, require authentication, and use a named ACL identity with only the cart key pattern and required commands. Update the cart client before disabling anonymous access.',
    ],
    references: [CWE, OWASP, REDIS, ACL],
  }
  return {
    ...common, title: 'Unverified access boundary on a route to a critical asset', severity: 'Needs validation',
    controlAssetId: route.nodes.at(-1) ?? '',
    category: 'Network exposure review', classification: 'No vulnerability classification confirmed',
    service: `Route to ${target} · service and port not established`,
    summary: `The captured topology contains a route from ${names[0] ?? 'an entry asset'} to ${target}. This is a useful place to review trust boundaries, but it does not demonstrate an authentication bypass or an exploitable service.`,
    rootCause: 'A missing access boundary is a hypothesis. Connection evidence alone cannot establish whether the current routing, firewall rules and application controls are adequate.',
    impact: ['If a required access control is absent, an attacker with the necessary foothold might reach a sensitive service.', 'Data disclosure, privilege gain and code execution have not been demonstrated.'],
    prerequisites: ['An attacker must obtain the stated entry foothold.', 'Each hop must remain reachable and lack a control needed to prevent the proposed action.'],
    evidence: [{label: 'Candidate connectivity', detail: `${route.hop_count} hops were returned by the path API. See the hop evidence below for sources and freshness.`, source: 'Topology snapshot · /api/paths'}, {label: 'Active validation', detail: 'No service-level request, identity check or exploit test has run.', source: 'Execution status · not tested'}],
    remediation: ['Review the access purpose and enforce explicit source, destination, identity and port restrictions where needed.', 'Preserve required business traffic and test the candidate change on an isolated copy before rollout.'],
    validation: ['Check the actual application protocol and authentication behavior at each hop.', 'Verify that unauthorized traffic is denied while legitimate traffic succeeds.', 'Capture dated, correlated evidence before claiming the route is exploitable or fixed.'],
    detection: 'Correlate unexpected service connections and authorization denials with the affected asset identities.',
    rollback: 'Keep a versioned copy of the prior policy and validate restoration on an isolated copy before making a real change.',
    related: [], references: [SEGMENTATION],
  }
}

export function hopEvidence(route: Assessment, topology: Topology) {
  return route.nodes.slice(1).map((node, index) => {
    const step = route.steps[index]
    return {from: assetLabel(topology, route.nodes[index]), to: assetLabel(topology, node),
      kind: step?.kind ?? 'NOT_RECORDED', source: step?.evidence_source ?? 'Not recorded',
      observedAt: step?.observed_at ?? null, freshness: step?.freshness ?? 'unknown'}
  })
}

export function reportData(scan: ScanReport, fixed: string[]) {
  return {schema: 'twinhunter.frontend-report.v1', reportId: scan.id, snapshotCapturedAt: scan.capturedAt,
    mode: scan.codebase ? 'Pinned source review with illustrative topology replay' : 'Frontend demonstration',
    codebase: scan.codebase ? {url: scan.codebase.url, commit: scan.codebase.commit, status: scan.codebase.status} : null,
    execution: {llmCalled: false, liveProbesExecuted: false, liveChangesApplied: false},
    summary: {reviewedRoutes: scan.routes.length, unresolvedFindings: scan.routes.filter(route => !fixed.includes(route.id)).length,
      fixedInCurrentScan: scan.routes.filter(route => fixed.includes(route.id)).length, previousDemoFixes: fixed.length,
      availableCandidates: scan.total, truncated: scan.truncated},
    scope: 'Captured topology, supplied deployment-source scenarios and published security guidance. Absence of a demo path is not an assurance that the live environment is secure.',
    findings: scan.routes.map(route => ({...analyzeFinding(route, scan.topology, scan.codebase), routeId: route.id,
      status: scan.codebase ? 'Vulnerable source; runtime unverified' : fixed.includes(route.id) ? 'Remediated in simulation' : 'Unverified scenario',
      path: route.nodes.map(id => assetLabel(scan.topology, id)), hops: hopEvidence(route, scan.topology), telemetryIssues: route.issues})),
  }
}

export function reportMarkdown(scan: ScanReport, fixed: string[]) {
  const data = reportData(scan, fixed)
  const lines = ['# TwinHunter vulnerability analysis report', '', `Report: ${scan.id}`, `Topology captured: ${scan.capturedAt}`, '',
    `**${data.mode} — no live probes, LLM calls or AWS changes.**`, '', data.scope, '',
    `Findings: ${data.summary.unresolvedFindings} unresolved; ${data.summary.fixedInCurrentScan} remediated in simulation.`,
    `Previous demo fixes retained: ${fixed.length}. Candidate results truncated: ${scan.truncated ? 'yes' : 'no'}.`, '']
  if (scan.codebase) lines.push(`Repository: ${scan.codebase.url}`, `Commit: ${scan.codebase.commit}`, `Source status: ${scan.codebase.status}`, '')
  if (!scan.routes.length) lines.push('## No attack path found', '', scan.codebase ? 'No unresolved topology path reported for the checked source snapshot. AWS deployment is unverified.' : 'No unresolved paths were found in this preview. Previously simulated fixes remain applied.', '')
  for (const finding of data.findings) {
    lines.push(`## ${finding.id}: ${finding.title}`, '', `${finding.severity} (scenario priority) | ${finding.status} | ${finding.classification}`, '',
      `Service: ${finding.service}`, `Basis: ${finding.basis}`, '', '### Executive analysis', '', finding.summary, '', '### Root cause', '', finding.rootCause, '',
      '### Impact and prerequisites', '', ...finding.impact.map(value => `- ${value}`), '', ...finding.prerequisites.map(value => `- Prerequisite: ${value}`), '',
      '### Attack path and evidence', '', finding.path.join(' → '), '',
      ...finding.hops.map(hop => `- ${hop.from} → ${hop.to}: ${hop.kind}; ${hop.source}; observed ${hop.observedAt ?? 'not recorded'}; freshness ${hop.freshness}.`), '',
      ...finding.evidence.map(value => `- ${value.label}: ${value.detail} [${value.source}]`), '',
      ...finding.telemetryIssues.map(value => `- Telemetry issue: ${value.asset_id}; ${value.reason}.`), '',
      '### Remediation plan', '', ...finding.remediation.map((value, index) => `${index + 1}. ${value}`), '',
      '### Verification plan (not executed)', '', ...finding.validation.map(value => `- ${value}`), '',
      '### Detection and rollback', '', finding.detection, '', finding.rollback, '',
      '### Limits of the conclusion', '', finding.limitation, '',
      ...(finding.related.length ? ['### Related hardening observations', '', ...finding.related.map(value => `- ${value}`), ''] : []),
      '### Research references', '', ...finding.references.map(value => `- [${value.title}](${value.url})`), '')
  }
  return lines.join('\n')
}
