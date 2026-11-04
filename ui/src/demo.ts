/**
 * Synthetic multi-tenant backend for UI development (VITE_DEMO=1 with `npm run dev`).
 * Every value here is invented and labelled as demo data in the interface.
 */
import type {Agent, AuditRow, Billing, Customer, EnrollmentToken, GraphEdge, GraphNode, Host, PathReport, PendingInvite, Principal, Run, RunDetail, TeamMember, TenantInfo, Topology, Verdict} from './types'

type HostSpec = {name: string; os: string; services: [string, string][]; entry?: boolean; critical?: boolean; stale?: boolean; gaps?: number}
type TenantSpec = {id: string; name: string; role: Principal['role']; hosts: HostSpec[]; links: [string, string, 'O' | 'I'][]; status?: 'active' | 'suspended'; createdAt?: string}

const TENANTS: TenantSpec[] = [
  {id: 'acme', name: 'Acme Financial', role: 'admin', hosts: [
    {name: 'edge-proxy', os: 'linux', services: [['nginx', '1.24.0']], entry: true},
    {name: 'vpn-gw', os: 'linux', services: [['openssh', '9.6']], entry: true},
    {name: 'web-01', os: 'linux', services: [['nginx', '1.24.0']]},
    {name: 'web-02', os: 'linux', services: [['nginx', '1.22.1']], gaps: 1},
    {name: 'api-01', os: 'linux', services: [['nginx', '1.24.0'], ['openssh', '9.6']]},
    {name: 'api-02', os: 'linux', services: [['openssh', '9.3']]},
    {name: 'jump-win', os: 'windows', services: [['openssh', '9.5']], stale: true},
    {name: 'cache-01', os: 'linux', services: [['redis', '7.2.4']]},
    {name: 'ledger-db', os: 'linux', services: [['postgresql', '16.2']], critical: true},
    {name: 'replica-db', os: 'linux', services: [['postgresql', '16.2']]},
    {name: 'payments', os: 'linux', services: [['redis', '7.0.15'], ['nginx', '1.24.0']], critical: true},
    {name: 'monitor', os: 'linux', services: [['nginx', '1.25.3']]},
  ], links: [
    ['edge-proxy', 'web-01', 'O'], ['edge-proxy', 'web-02', 'O'], ['web-01', 'api-01', 'O'], ['web-02', 'api-02', 'O'],
    ['api-01', 'ledger-db', 'O'], ['api-01', 'cache-01', 'O'], ['api-02', 'payments', 'O'], ['api-02', 'cache-01', 'I'],
    ['vpn-gw', 'jump-win', 'O'], ['jump-win', 'api-02', 'I'], ['jump-win', 'replica-db', 'I'], ['replica-db', 'ledger-db', 'O'],
    ['cache-01', 'payments', 'I'], ['monitor', 'web-01', 'O'], ['monitor', 'api-01', 'O'],
  ]},
  {id: 'globex', name: 'Globex Health', role: 'operator', hosts: [
    {name: 'portal', os: 'linux', services: [['nginx', '1.18.0']], entry: true},
    {name: 'ehr-app', os: 'linux', services: [['nginx', '1.24.0']]},
    {name: 'imaging', os: 'windows', services: [['openssh', '8.9']], gaps: 2},
    {name: 'sessions', os: 'linux', services: [['redis', '6.2.14']]},
    {name: 'patient-db', os: 'linux', services: [['postgresql', '14.11']], critical: true},
    {name: 'admin-ws', os: 'windows', services: [['openssh', '9.5']], entry: true, stale: true},
    {name: 'backup', os: 'linux', services: [['openssh', '9.6']]},
  ], links: [
    ['portal', 'ehr-app', 'O'], ['ehr-app', 'sessions', 'O'], ['ehr-app', 'patient-db', 'O'], ['admin-ws', 'imaging', 'I'],
    ['imaging', 'patient-db', 'I'], ['admin-ws', 'backup', 'O'], ['backup', 'patient-db', 'O'], ['sessions', 'patient-db', 'I'],
  ]},
  {id: 'initech', name: 'Initech Retail', role: 'viewer', hosts: [
    {name: 'storefront', os: 'linux', services: [['nginx', '1.24.0']], entry: true},
    {name: 'checkout', os: 'linux', services: [['nginx', '1.24.0']]},
    {name: 'inventory', os: 'linux', services: [['postgresql', '15.6']]},
    {name: 'carts', os: 'linux', services: [['redis', '7.2.4']]},
    {name: 'orders-db', os: 'linux', services: [['postgresql', '15.6']], critical: true},
  ], links: [
    ['storefront', 'checkout', 'O'], ['checkout', 'carts', 'O'], ['checkout', 'orders-db', 'O'], ['storefront', 'inventory', 'I'], ['inventory', 'orders-db', 'O'],
  ]},
]

const PRINCIPAL_ID = 'demo.analyst'
let current: TenantSpec | null = null   // null = platform console
let signedIn = false
const revoked = new Set<string>()
const reenrolledIds: Record<string, string> = {}
// Like the real platform: creating a customer does not make the platform admin a member; accepting its invite does.
const memberOf = new Set(['acme', 'globex', 'initech'])
const inviteTenant: Record<string, string> = {}
const tokens: Record<string, (EnrollmentToken & {secret: string})[]> = {}
const enrolledAt: Record<string, string> = {}
const team: Record<string, TeamMember[]> = {}
const invites: Record<string, PendingInvite[]> = {}
// Machines that "join" after an install command is generated, so the twin visibly builds itself.
const JOINERS: [HostSpec, [string, string, 'O' | 'I'][]][] = [
  [{name: 'web-01', os: 'linux', services: [['nginx', '1.24.0']]}, []],
  [{name: 'app-01', os: 'linux', services: [['nginx', '1.24.0'], ['openssh', '9.6']]}, [['web-01', 'app-01', 'O']]],
  [{name: 'db-01', os: 'linux', services: [['postgresql', '16.2']]}, [['app-01', 'db-01', 'O']]],
  [{name: 'cache-01', os: 'linux', services: [['redis', '7.2.4']]}, [['app-01', 'cache-01', 'O']]],
  [{name: 'admin-ws', os: 'windows', services: [['openssh', '9.5']]}, [['admin-ws', 'app-01', 'I']]],
]
const classified: Record<string, {entry: boolean; critical: boolean}> = {}
const runs: Record<string, RunDetail[]> = {}
// Demo-only harness results: hops confirmed by "Confirm hops in twin" and the repair verified per route.
const confirmedHops: Record<string, Map<string, string>> = {}
const repairs: Record<string, Map<string, {service: string; change: string; retest: string; workflows: string}>> = {}
const FIXES: Record<string, {change: string; retest: string; workflows: string}> = {
  nginx: {change: 'server_tokens on → off', retest: 'version header no longer disclosed', workflows: 'storefront pages and API proxy still served'},
  redis: {change: 'protected-mode no → yes, requirepass set', retest: 'unauthenticated command refused', workflows: 'cart sessions still read and written'},
  postgresql: {change: 'pg_hba trust → scram-sha-256', retest: 'passwordless login refused', workflows: 'application role still queries orders'},
  openssh: {change: 'PasswordAuthentication yes → no', retest: 'password login refused', workflows: 'key-based admin login still works'},
}
const minutesAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString()
const hostId = (t: TenantSpec, name: string) => reenrolledIds[`${t.id}|${name}`] ?? `${t.id.slice(0, 2)}${name.replace(/[^a-z0-9]/g, '')}`.padEnd(14, '0').slice(0, 14)

function topology(t: TenantSpec): Topology {
  const nodes: GraphNode[] = [], edges: GraphEdge[] = []
  for (const h of t.hosts.filter(x => !revoked.has(hostId(t, x.name)))) {
    const id = hostId(t, h.name), override = classified[`${t.id}|${id}`]
    nodes.push({id, labels: ['Asset', 'Host'], properties: {hostname: h.name, os: h.os, os_version: h.os === 'linux' ? 'Ubuntu 24.04' : 'Windows Server 2022',
      architecture: 'amd64', agent_id: id, last_seen: minutesAgo(h.stale ? 42 : 1), entry: override?.entry ?? !!h.entry, critical: override?.critical ?? !!h.critical}})
    for (const [kind, version] of h.services) {
      const sid = `service:${id}:${kind}`
      nodes.push({id: sid, labels: ['Asset', 'Component'], properties: {kind: 'service', hash: sid.length.toString(16), confidence: 'observed',
        evidence_source: 'agent.collector', observed_at: minutesAgo(2), data_json: JSON.stringify({name: kind, version, state: 'running'})}})
      edges.push({source: id, target: sid, kind: 'HAS_SERVICE', properties: {}})
    }
  }
  for (const [a, b, k] of t.links.filter(([a, b]) => !revoked.has(hostId(t, a)) && !revoked.has(hostId(t, b)))) {
    const stale = t.hosts.find(h => h.name === a)?.stale
    edges.push({source: hostId(t, a), target: hostId(t, b), kind: k === 'O' ? 'OBSERVED_CONNECTION' : 'INFERRED_REACHABILITY',
      properties: {observed_at: minutesAgo(stale ? 40 : 3), evidence_source: k === 'O' ? 'socket.established' : 'firewall.allow', confidence: k === 'O' ? 'observed' : 'inferred'}})
  }
  return {nodes, edges, truncated_nodes: false, truncated_edges: false}
}

function inventory(t: TenantSpec): Agent[] {
  return t.hosts.filter(h => !revoked.has(hostId(t, h.name))).map((h, i) => ({agent_id: hostId(t, h.name), last_sequence: 120 + i * 17, last_seen: minutesAgo(h.stale ? 42 : 1), needs_full: !!h.stale, stale: !!h.stale,
    gaps: Array.from({length: h.gaps ?? 0}, (_, g) => ({collector: g ? 'firewall' : 'privileges', field: g ? 'rules' : 'sudoers', reason: 'permission_denied', detail: 'collector lacks read access'}))}))
}

function paths(t: TenantSpec, maxDepth: number, isolated: string | null): PathReport {
  const topo = topology(t), live = topo.edges.filter(e => e.kind === 'OBSERVED_CONNECTION' || e.kind === 'INFERRED_REACHABILITY')
  const hosts = topo.nodes.filter(n => n.labels.includes('Host'))
  const entries = hosts.filter(n => n.properties.entry).map(n => n.id), critical = hosts.filter(n => n.properties.critical).map(n => n.id)
  const found: string[][] = []
  const walk = (route: string[]) => {
    const last = route[route.length - 1]
    if (route.length > 1 && critical.includes(last)) { found.push(route); return }
    if (route.length > maxDepth) return
    for (const e of live) if (e.source === last && !route.includes(e.target)) walk([...route, e.target])
  }
  entries.forEach(e => walk([e]))
  found.sort((a, b) => a.length - b.length)
  const stale = new Set(t.hosts.filter(h => h.stale).map(h => hostId(t, h.name))), gappy = new Map(t.hosts.filter(h => h.gaps).map(h => [hostId(t, h.name), h.gaps!]))
  const assessments = found.map((nodes, i) => ({
    id: `p${i}-${nodes.join('').slice(0, 10)}`, nodes, hop_count: nodes.length - 1, review_order: i + 1,
    steps: nodes.slice(1).map((target, k) => { const e = live.find(x => x.source === nodes[k] && x.target === target)!
      const run = confirmedHops[t.id]?.get(`${nodes[k]}>${target}`)
      return {source: nodes[k], target, kind: e.kind, observed_at: String(e.properties.observed_at), evidence_source: String(e.properties.evidence_source), freshness: stale.has(nodes[k]) ? 'stale' : 'current',
        confirmed: Boolean(run), ...(run ? {confirmation: {evidence_source: `sandbox:${run.slice(0, 8)}`, observed_at: new Date().toISOString(), basis: ['confirmed_chain_scenario'], test_ids: ['scenario.http_chain'], run_id: run}} : {})} }),
    issues: nodes.flatMap((n, k) => [...(stale.has(n) ? [{asset_id: n, reason: 'STALE_AGENT', step: k}] : []), ...(gappy.has(n) ? [{asset_id: n, reason: 'COLLECTION_GAPS', gap_count: gappy.get(n)}] : [])]),
    next_action: 'Validate each hop in an isolated twin before treating this route as exploitable.',
  })).map(a => {
    const proven = a.steps.filter(s => s.confirmed).length
    const status = proven === a.steps.length ? 'proven' as const : proven ? 'partially_confirmed' as const : 'unvalidated' as const
    const remediation = repairs[t.id]?.get(a.nodes.join('>'))
    return {...a, validation_status: status, confirmed_hops: proven, ...(remediation ? {remediation} : {}),
      next_action: status === 'proven' ? 'Every hop was reproduced on isolated replicas. Remediate the confirmed services, then re-test.'
        : status === 'partially_confirmed' ? `${proven} of ${a.steps.length} hops are confirmed. Validate the remaining hops in an isolated scenario.` : a.next_action}
  })
  const counts = new Map<string, number>()
  found.forEach(p => p.slice(1, -1).forEach(n => counts.set(n, (counts.get(n) ?? 0) + 1)))
  const label = (id: string) => String(hosts.find(h => h.id === id)?.properties.hostname ?? id)
  const affected = isolated ? found.filter(p => p.includes(isolated)).length : 0
  return {assessments, warnings: [], ordering: 'Ordered by fewer hops, then fewer telemetry issues.',
    universe: {entries, critical, path_count: found.length, max_paths: 500, max_states: 10000, truncated: false, generated_at: new Date().toISOString(),
      freshness_threshold_seconds: 180, assumptions: ['Directed observed and inferred edges only.', 'Structural and archetype edges are excluded.', 'No route is validated by this analysis.']},
    review_points: [...counts].sort((a, b) => b[1] - a[1]).map(([asset_id, path_count]) => ({asset_id, label: label(asset_id), path_count})),
    isolation_preview: isolated ? {asset_id: isolated, affected_count: affected, remaining_count: found.length - affected,
      scope: 'Counts apply to the returned candidate routes.', limitation: 'Real segmentation must be tested for security and legitimate workflows.'} : null}
}

const VERDICTS: Verdict[] = ['confirmed', 'not_reproduced', 'inconclusive', 'confirmed', 'unsupported', 'not_reproduced']
const TESTS: Record<string, string> = {nginx: 'nginx.version_header', postgresql: 'postgresql.trust_access', redis: 'redis.unauthenticated_ping', openssh: 'openssh.password_auth'}

function seedRun(t: TenantSpec, status: string, createdMinutesAgo: number, waveCount: number): RunDetail {
  const report = paths(t, 4, null), topo = topology(t)
  const serviceOf = (host: string) => topo.edges.filter(e => e.source === host && e.kind === 'HAS_SERVICE').map(e => e.target)
  const chosen = report.assessments.slice(0, Math.max(1, waveCount * 2))
  const waves = Array.from({length: waveCount}, (_, w) => { const paths = chosen.filter((_, i) => i % waveCount === w)
    const services = [...new Set(paths.flatMap(p => p.nodes.flatMap(serviceOf)))].slice(0, 5)
    return {index: w, service_ids: services, path_ids: paths.map(p => p.id), cpu_millis: 400 + services.length * 150, ram_mb: 256 * services.length} })
  const id = crypto.randomUUID(), done = status === 'completed'
  const findings = waves.flatMap((w, wi) => (done || wi === 0 ? w.service_ids : []).map((sid, k) => {
    const kind = sid.split(':').at(-1)!
    return {id: crypto.randomUUID(), target_id: sid, test_id: TESTS[kind] ?? 'nmap.port', verdict: VERDICTS[(k + wi + sid.length) % VERDICTS.length], wave_index: w.index,
      image_id: 'sha256:' + Math.abs(sid.length * 9973).toString(16).padEnd(12, 'a'), snapshot_hash: 'sha256:' + (sid.length * 7919).toString(16).padEnd(12, 'c'),
      fidelity_gaps: k % 3 === 2 ? ['directive include not rendered'] : [], observations: {exit_code: 0}, recorded_at: minutesAgo(createdMinutesAgo - 2 - k)}
  }))
  const validated = done ? chosen.slice(0, 1).map(p => p.id) : []
  return {run: {id, status, created_at: minutesAgo(createdMinutesAgo), cleanup_status: done ? 'complete' : 'pending', peak_cpu_millis: 1450, peak_ram_mb: 1820,
    plan: {path_universe_size: report.assessments.length, planned_paths: chosen.length, untested_paths: report.assessments.length - chosen.length,
      excluded: [{id: 'service:windows:rdp', reason: 'no catalog mapping for linux/amd64'}], waves, paths: chosen.map(p => ({id: p.id, nodes: p.nodes}))}},
    waves: waves.map((w, i) => ({wave_index: w.index, status: done || i === 0 ? 'completed' : 'running', service_ids: w.service_ids, path_ids: w.path_ids,
      health: Object.fromEntries(w.service_ids.map(s => [s, {ready: true, isolation: {passed: true}}]))})),
    findings, validated_path_ids: validated, unvalidated_path_ids: chosen.map(p => p.id).filter(x => !validated.includes(x)), hunts: []}
}

function runsFor(t: TenantSpec) {
  runs[t.id] ??= [seedRun(t, 'completed', 180, 2), ...(t.id === 'acme' ? [seedRun(t, 'completed', 1440, 3)] : [])]
  return runs[t.id]
}

function audit(t: TenantSpec): AuditRow[] {
  const actions = ['session.login', 'topology.read', 'paths.read', 'asset.classify', 'plan.create', 'run.queue', 'evidence.read', 'session.switch_tenant']
  return Array.from({length: 24}, (_, i) => ({id: i, recorded_at: minutesAgo(i * 7 + 1), actor: i % 5 === 3 ? 'ops.bot' : PRINCIPAL_ID, role: t.role,
    action: actions[i % actions.length], stage: i % 9 === 4 ? 'denied' : i % 2 ? 'outcome' : 'intent', status: i % 9 === 4 ? 403 : i % 2 ? 200 : null, request_id: crypto.randomUUID()}))
}

function session(): Principal {
  return {id: PRINCIPAL_ID, role: current?.role ?? 'viewer', tenant: current?.id ?? '', auth_mode: 'tokens', platform_admin: true, kind: 'password',
    display_name: 'Demo Analyst', tenants: TENANTS.filter(t => t.status !== 'suspended' && memberOf.has(t.id)).map(t => ({id: t.id, name: t.name, role: t.role}))}
}

function hostsFor(t: TenantSpec): Host[] {
  return t.hosts.map((h, i) => { const id = hostId(t, h.name)
    return {agent_id: id, hostname: h.name, os: h.os, enrolled_at: enrolledAt[id] ?? minutesAgo(2880 + i * 60), certificate_expires_at: new Date(Date.now() + 340 * 86400000).toISOString(),
      revoked_at: revoked.has(id) ? minutesAgo(1) : null, revoked_by: revoked.has(id) ? PRINCIPAL_ID : null,
      last_seen: revoked.has(id) ? minutesAgo(5) : minutesAgo(h.stale ? 42 : enrolledAt[id] ? 0 : 1), last_sequence: 40 + i} })
}

function teamFor(t: TenantSpec): TeamMember[] {
  team[t.id] ??= [{id: PRINCIPAL_ID, display_name: 'Demo Analyst', role: t.role, last_login: minutesAgo(1), managed_by: 'database'},
    {id: 'priya.it', display_name: 'Priya Raman', role: 'operator', last_login: minutesAgo(190), managed_by: 'database'},
    {id: 'sam.soc', display_name: 'Sam Okafor', role: 'viewer', last_login: null, managed_by: 'database'}]
  return team[t.id]
}

function customers(): Customer[] {
  return TENANTS.map((t, i) => { const live = t.hosts.filter(h => !revoked.has(hostId(t, h.name)))
    return {id: t.id, name: t.name, status: t.status ?? 'active', managed_by: 'database', members: teamFor(t).length,
      enrolled_agents: live.length, known_agents: live.length, reporting_agents: live.filter(h => !h.stale).length,
      last_report: live.length ? minutesAgo(1) : null, runs: runs[t.id]?.length ?? (t.hosts.length ? 2 - (i % 2) : 0), active_runs: i === 0 ? 1 : 0,
      pending_invites: (invites[t.id] ?? []).length, created_at: t.createdAt ?? minutesAgo(43200 - i * 9000)} })
}

function simulateJoins(t: TenantSpec, token: EnrollmentToken & {secret: string}) {
  const removed: typeof JOINERS = t.hosts.filter(h => revoked.has(hostId(t, h.name)))
    .map(h => [h, t.links.filter(([a, b]) => a === h.name || b === h.name)])
  const available = [...removed, ...JOINERS]
    .filter(([spec], index, all) => all.findIndex(([candidate]) => candidate.name === spec.name) === index)
    .filter(([spec]) => !t.hosts.some(h => h.name === spec.name && !revoked.has(hostId(t, h.name))))
    .slice(0, Math.min(token.max_uses, 3))
  available.forEach(([spec, links], i) => setTimeout(() => {
    if (token.revoked || token.uses >= token.max_uses) return
    if (t.hosts.some(h => h.name === spec.name && revoked.has(hostId(t, h.name)))) {
      t.hosts = t.hosts.filter(h => h.name !== spec.name)
      reenrolledIds[`${t.id}|${spec.name}`] = `demo-${crypto.randomUUID()}`
    }
    t.hosts.push({...spec, services: [...spec.services]})
    for (const link of links) if (!t.links.some(existing => existing.join('|') === link.join('|')) && t.hosts.some(h => h.name === link[0]) && t.hosts.some(h => h.name === link[1])) t.links.push(link)
    enrolledAt[hostId(t, spec.name)] = new Date().toISOString()
    token.uses++
  }, 5000 + i * 4500))
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}})
const ROLE_RANK = {viewer: 0, operator: 1, admin: 2}
const billing: Record<string, Billing> = {}
function billingFor(id: string): Billing {
  return billing[id] ??= {subscription: {plan: 'trial', status: 'trialing', current_period_end: new Date(Date.now() + 14 * 86400000).toISOString(), updated_at: new Date().toISOString()}, payments: []}
}

export async function demoFetch(method: string, path: string, body: unknown): Promise<Response> {
  await new Promise(r => setTimeout(r, 120 + Math.random() * 180))
  const url = new URL(path, 'http://demo'), route = url.pathname
  const b = (body ?? {}) as Record<string, unknown>
  if (route === '/api/setup') return json({needed: false})
  const invited = TENANTS.find(x => x.id === inviteTenant[String(b.token ?? '')])
  if (route === '/api/invites/describe') return invited
    ? json({tenant_id: invited.id, tenant_name: invited.name, role: 'admin', platform_admin: false, expires_at: new Date(Date.now() + 72 * 3600000).toISOString()})
    : json({detail: 'this invite is invalid, expired or already used'}, 404)
  if (route === '/api/invites/accept') {
    if (!invited) return json({detail: 'this invite is invalid, expired or already used'}, 400)
    memberOf.add(invited.id); invites[invited.id] = []; delete inviteTenant[String(b.token)]
    return json({ok: true, tenant_id: invited.id, role: 'admin', platform_admin: false})
  }

  if (route === '/api/auth/login') { signedIn = true; current = TENANTS.find(x => x.id === b.tenant && memberOf.has(x.id)) ?? null; return json(session()) }
  if (route === '/api/auth/logout') { signedIn = false; return json({ok: true}) }
  if (!signedIn) return json({detail: 'authentication required'}, 401)
  if (route === '/api/auth/session') return json(session())
  if (route === '/api/auth/tenant') {
    if (b.tenant === '') { current = null; return json(session()) }
    const next = TENANTS.find(x => x.id === b.tenant && x.status !== 'suspended' && memberOf.has(x.id)); if (!next) return json({detail: 'no active membership in the requested tenant'}, 403)
    current = next; return json(session())
  }
  // ---------------------------------------------------------------- platform console
  if (route === '/api/platform/tenants' && method === 'GET') return json(customers())
  const platformBilling = route.match(/^\/api\/platform\/tenants\/([^/]+)\/billing$/)
  if (platformBilling) return TENANTS.some(x => x.id === platformBilling[1]) ? json(billingFor(platformBilling[1])) : json({detail: 'customer not found'}, 404)
  if (route === '/api/platform/tenants' && method === 'POST') {
    const id = String(b.id ?? ''), name = String(b.name ?? '').trim()
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id) || !name) return json({detail: 'customer IDs are lowercase letters, digits and hyphens'}, 400)
    if (TENANTS.some(x => x.id === id)) return json({detail: 'a customer with that ID already exists'}, 400)
    TENANTS.push({id, name, role: 'admin', hosts: [], links: [], status: 'active', createdAt: new Date().toISOString()})
    invites[id] = [{id: crypto.randomUUID(), role: 'admin', label: String(b.admin_label || 'First administrator'), created_by: PRINCIPAL_ID, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 72 * 3600000).toISOString()}]
    const token = 'dti_demo_' + crypto.randomUUID().replaceAll('-', '')
    inviteTenant[token] = id
    return json({tenant: {id, name, status: 'active'}, invite_token: token, invite: invites[id][0]}, 201)
  }
  const status = route.match(/^\/api\/platform\/tenants\/([^/]+)\/status$/)
  if (status) { const x = TENANTS.find(y => y.id === status[1]); if (!x) return json({detail: 'customer not found'}, 404); x.status = b.status as 'active' | 'suspended'; return json({ok: true}) }
  const reinvite = route.match(/^\/api\/platform\/tenants\/([^/]+)\/invites$/)
  if (reinvite) { const token = 'dti_demo_' + crypto.randomUUID().replaceAll('-', ''); inviteTenant[token] = reinvite[1]
    return json({invite_token: token, invite: {id: crypto.randomUUID(), tenant_id: reinvite[1], role: 'admin', expires_at: new Date(Date.now() + 72 * 3600000).toISOString()}}, 201) }
  if (route === '/api/platform/admins/invites') return json({invite_token: 'dti_demo_' + crypto.randomUUID().replaceAll('-', ''), invite: {id: crypto.randomUUID(), tenant_id: null, role: 'admin', expires_at: new Date(Date.now() + 72 * 3600000).toISOString()}}, 201)
  const t = current
  if (!t) return json({detail: 'select a customer workspace first'}, 403)
  const need = (role: keyof typeof ROLE_RANK) => ROLE_RANK[t.role] >= ROLE_RANK[role]
  if (route === '/api/billing' && method === 'GET') return json(billingFor(t.id))
  if (route === '/api/billing/demo-checkout' && method === 'POST') {
    if (!need('admin')) return json({detail: 'role does not permit this action'}, 403)
    if (t.status === 'suspended') return json({detail: 'this customer is suspended'}, 400)
    if (b.plan !== 'starter' && b.plan !== 'business') return json({detail: 'invalid demo plan'}, 400)
    const status = b.outcome === 'failed' ? 'failed' : 'succeeded', now = new Date().toISOString(), data = billingFor(t.id)
    const plan = b.plan as 'starter' | 'business'
    const payment: Billing['payments'][number] = {id: crypto.randomUUID(), plan, amount_paise: plan === 'starter' ? 49900 : 149900, currency: 'INR', status, created_by: PRINCIPAL_ID, created_at: now}
    data.payments.unshift(payment)
    if (status === 'succeeded') data.subscription = {plan: b.plan, status: 'active', current_period_end: new Date(Date.now() + 30 * 86400000).toISOString(), updated_at: now}
    return json(payment, 201)
  }
  // ---------------------------------------------------------------- hosts, enrollment, team
  if (route === '/api/hosts') return json(hostsFor(t))
  const revokeHost = route.match(/^\/api\/hosts\/([^/]+)\/revoke$/)
  if (revokeHost) { if (!need('admin')) return json({detail: 'role does not permit this action'}, 403); revoked.add(revokeHost[1]); return json({ok: true}) }
  if (route === '/api/enrollment/tokens' && method === 'GET') return need('admin') ? json({enabled: true, tokens: (tokens[t.id] ?? []).map(({secret: _secret, ...x}) => ({...x, usable: !x.revoked && x.uses < x.max_uses && new Date(x.expires_at) > new Date()}))}) : json({detail: 'role does not permit this action'}, 403)
  if (route === '/api/enrollment/tokens' && method === 'POST') {
    if (!need('admin')) return json({detail: 'role does not permit this action'}, 403)
    const token = {id: crypto.randomUUID(), label: String(b.label ?? ''), created_by: PRINCIPAL_ID, created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + Number(b.minutes ?? 60) * 60000).toISOString(), max_uses: Number(b.max_uses ?? 1), uses: 0, revoked: false, usable: true,
      secret: 'dtk_demo' + crypto.randomUUID().replaceAll('-', '')}
    ;(tokens[t.id] ??= []).unshift(token)
    simulateJoins(t, token)
    return json({token: token.secret, ...token, server_address: 'twin.example:8443'}, 201)
  }
  const revokeToken = route.match(/^\/api\/enrollment\/tokens\/([^/]+)\/revoke$/)
  if (revokeToken) { const x = (tokens[t.id] ?? []).find(y => y.id === revokeToken[1]); if (x) x.revoked = true; return json({ok: true}) }
  if (route.startsWith('/api/team') && !need('admin')) return json({detail: 'role does not permit this action'}, 403)
  if (route === '/api/team') return json({members: teamFor(t), invites: invites[t.id] ?? []})
  if (route === '/api/team/invites') { const invite = {id: crypto.randomUUID(), role: b.role as PendingInvite['role'], label: String(b.label ?? ''), created_by: PRINCIPAL_ID, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 72 * 3600000).toISOString()}
    ;(invites[t.id] ??= []).unshift(invite); return json({invite_token: 'dti_demo_' + crypto.randomUUID().replaceAll('-', ''), invite}, 201) }
  const teamInvite = route.match(/^\/api\/team\/invites\/([^/]+)$/)
  if (teamInvite) { invites[t.id] = (invites[t.id] ?? []).filter(x => x.id !== teamInvite[1]); return json({ok: true}) }
  const member = route.match(/^\/api\/team\/members\/([^/]+)$/)
  if (member) {
    const members = teamFor(t), id = decodeURIComponent(member[1]), target = members.find(m => m.id === id)
    if (!target) return json({detail: 'member not found'}, 404)
    const after = method === 'DELETE' ? members.filter(m => m.id !== id) : members.map(m => m.id === id ? {...m, role: b.role as TeamMember['role']} : m)
    if (!after.some(m => m.role === 'admin')) return json({detail: 'a workspace needs at least one admin'}, 400)
    team[t.id] = after; return json({ok: true})
  }
  if (route === '/api/tenant') return json({id: t.id, name: t.name, status: 'active', registered_agents: t.hosts.length, accepts_unregistered_agents: false,
    quotas: {max_pending_runs: 3, max_run_cpu_millis: 2000, max_run_ram_mb: 4096, max_path_depth: 8},
    managed_by: 'database', isolation: {graph: 'tenant-scoped node keys', history: 'tenant-keyed rows', events: 'tenant-partitioned stream', sandbox: 'per-run internal networks labeled by tenant'}} satisfies TenantInfo)
  if (route === '/api/inventory') return json(inventory(t))
  if (route === '/api/codebase' && method === 'GET') return json({codebase: null, pr_enabled: false})
  if (route.startsWith('/api/codebase')) return json({detail: 'Use the connected backend to verify a GitHub repository; synthetic demo mode cannot create pull requests'}, 409)
  if (route === '/api/topology') return json(topology(t))
  if (route === '/api/paths') { const isolated = url.searchParams.get('isolated_asset'); return json(paths(t, Number(url.searchParams.get('max_depth') ?? 4), isolated)) }
  const classify = route.match(/^\/api\/assets\/(.+)\/classification$/)
  if (classify) { if (!need('operator')) return json({detail: 'role does not permit this action'}, 403); classified[`${t.id}|${decodeURIComponent(classify[1])}`] = body as {entry: boolean; critical: boolean}; return json({ok: true}) }
  if (route === '/api/emulation/runs' && method === 'GET') return json(runsFor(t).map(r => r.run))
  if (route === '/api/emulation/plans') {
    if (!need('operator')) return json({detail: 'role does not permit this action'}, 403)
    const draft = seedRun(t, 'running', 0, 2)
    return json({plan_id: draft.run.id, plan: draft.run.plan})
  }
  if (route === '/api/emulation/runs' && method === 'POST') {
    if (!need('operator')) return json({detail: 'role does not permit this action'}, 403)
    if (runsFor(t).filter(r => r.run.status === 'running').length >= 3) return json({detail: 'tenant run queue capacity reached'}, 409)
    const run = seedRun(t, 'running', 0, 2); runsFor(t).unshift(run)
    setTimeout(() => { const done = seedRun(t, 'completed', 0, 2); Object.assign(run, {...done, run: {...done.run, id: run.run.id, created_at: run.run.created_at}}) }, 9000)
    return json({run_id: run.run.id, status: 'queued'}, 202)
  }
  const promote = route.match(/^\/api\/emulation\/runs\/([^/]+)\/promote$/)
  if (promote && method === 'POST') {
    if (!need('operator')) return json({detail: 'role does not permit this action'}, 403)
    const r = runsFor(t).find(x => x.run.id === promote[1])
    if (!r) return json({detail: 'run not found'}, 404)
    if (r.run.status !== 'completed') return json({detail: 'only a completed run can confirm attack transitions'}, 409)
    const hops = (confirmedHops[t.id] ??= new Map()), fixed = (repairs[t.id] ??= new Map())
    const topo = topology(t), kindOf = (id: string) => id.split(':').at(-1)!
    let written = 0
    for (const p of r.run.plan?.paths ?? []) {
      const nodes = p.nodes ?? []
      if (!r.validated_path_ids.includes(p.id) || nodes.length < 2) continue
      nodes.slice(1).forEach((target, k) => { if (!hops.has(`${nodes[k]}>${target}`)) written++; hops.set(`${nodes[k]}>${target}`, r.run.id) })
      const services = nodes.flatMap(n => topo.edges.filter(e => e.source === n && e.kind === 'HAS_SERVICE').map(e => e.target))
      const weak = r.findings.find(f => f.verdict === 'confirmed' && services.includes(f.target_id) && FIXES[kindOf(f.target_id)])
      const service = weak?.target_id ?? services.find(s => FIXES[kindOf(s)])
      const owner = topo.edges.find(e => e.kind === 'HAS_SERVICE' && e.target === service)?.source
      const hostname = String(topo.nodes.find(n => n.id === owner)?.properties.hostname ?? owner ?? '')
      if (service) fixed.set(nodes.join('>'), {service: `${kindOf(service)} on ${hostname}`, ...FIXES[kindOf(service)]})
    }
    return json({run_id: r.run.id, written, confirmed_transitions: []})
  }
  const sarif = route.match(/^\/api\/emulation\/runs\/([^/]+)\/sarif$/)
  if (sarif) {
    const r = runsFor(t).find(x => x.run.id === sarif[1])
    if (!r) return json({detail: 'run not found'}, 404)
    const level: Record<string, string> = {confirmed: 'error', inconclusive: 'note', unsupported: 'note', not_reproduced: 'none'}
    const findings = r.findings.filter(f => f.verdict !== 'not_reproduced')
    const ruleIds = [...new Set(findings.map(f => f.test_id))]
    return json({version: '2.1.0', $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
      runs: [{tool: {driver: {name: 'Digital Twin', version: '4.0.0', rules: ruleIds.map(id => ({id, shortDescription: {text: `Twin policy check ${id}.`}}))}},
        properties: {run_id: r.run.id, tenant: t.id},
        results: findings.map(f => ({ruleId: f.test_id, ruleIndex: ruleIds.indexOf(f.test_id), level: level[f.verdict] ?? 'note',
          message: {text: `${f.test_id} on ${f.target_id}: ${f.verdict.replace('_', ' ')} (twin result under recorded conditions; not proof of production exploitability).`},
          locations: [{logicalLocations: [{fullyQualifiedName: f.target_id, kind: 'resource', name: f.target_id.split(':').at(-1)}]}],
          partialFingerprints: {'twinSnapshot/v1': `${f.test_id}:${f.target_id}:${f.snapshot_hash}`},
          properties: {verdict: f.verdict, snapshot_hash: f.snapshot_hash, image_id: f.image_id, fidelity_gaps: f.fidelity_gaps, observations: f.observations}}))}]})
  }
  const detail = route.match(/^\/api\/emulation\/runs\/(.+)$/)
  if (detail) { const r = runsFor(t).find(x => x.run.id === detail[1]); return r ? json(r) : json({detail: 'run not found'}, 404) }
  if (route === '/api/research/reports' && method === 'GET') return json(demoResearch.list())
  if (route === `/api/research/reports/${demoResearch.id}`) return json({report: demoResearch.report()})
  if (route === '/api/research/reports' && method === 'POST') return json({detail: 'saving is disabled in demo mode'}, 409)
  if (route === '/api/admin/audit') return need('admin') ? json(audit(t)) : json({detail: 'role does not permit this action'}, 403)
  return json({detail: 'not available in demo mode'}, 404)
}

// ------------------------------------------------------------------ synthetic research run
const DEMO_REPORT_ID = '00000000-0000-4000-8000-00000000d3e0'
function demoReport() {
  const kinds = ['nginx', 'postgresql', 'redis', 'openssh', 'nginx', 'redis', 'postgresql', 'openssh']
  const truths = [true, true, false, true, false, true, false, true]
  const hex = (n: number) => n.toString(16).padStart(8, '0').repeat(8)
  const rows = kinds.flatMap((kind, i) => {
    const scenario = `s${String(i + 1).padStart(2, '0')}`, truth = truths[i]
    const base = {scenario_id: scenario, repetition: 1, truth, truth_verified: true, snapshot_hash: hex(i + 1)}
    const target = {target_id: `${kind}-twin`, port: {nginx: 8080, postgresql: 5432, redis: 6379, openssh: 22}[kind]}
    const verdict = truth ? 'confirmed' : 'not_reproduced'
    const events: {kind: string; payload: Record<string, unknown>}[] = [
      {kind: 'hypothesis', payload: {text: `Configuration suggests a ${kind} policy weakness; inspect before testing.`}},
      {kind: 'action', payload: {name: 'inspect_config', ...target}},
      {kind: 'observation', payload: {status: 'observed', tool: 'inspect_config'}},
      ...(i % 3 === 1 ? [{kind: 'action', payload: {name: 'security_check', ...target, target_id: 'production-db'}},
        {kind: 'blocked', payload: {status: 'blocked', reason: 'target or port not registered for this run'}}] : []),
      {kind: 'hypothesis', payload: {text: 'Run the deterministic policy check to obtain executed evidence.'}},
      {kind: 'action', payload: {name: 'security_check', ...target}},
      {kind: 'observation', payload: {status: 'observed', tool: 'security_check', verdict}},
      ...(i % 4 === 2 ? [{kind: 'action', payload: {name: 'security_check', ...target}},
        {kind: 'blocked', payload: {status: 'duplicate', reason: 'identical action already executed; earlier observation returned'}}] : []),
      {kind: 'finished', payload: {status: i === 7 ? 'token_limit' : 'completed'}},
    ]
    const trace = events.map((e, k) => ({index: k, ...e, hash: hex(i * 31 + k + 7), previous_hash: k ? hex(i * 31 + k + 6) : '0'.repeat(64)}))
    const evidence = [{tool: 'security_check', verdict, target_id: target.target_id, snapshot_hash: hex(i + 1)}]
    const hunterPrediction = i === 7 ? null : i === 4 ? true : truth
    return [
      {...base, baseline: 'static_assessment', status: 'completed', prediction: i === 2 ? true : truth, elapsed_seconds: 0.01, assessment_kind: 'static_inference_not_confirmed_finding'},
      {...base, baseline: 'default_twins', status: kind === 'openssh' ? 'unsupported' : 'completed', prediction: kind === 'openssh' ? null : i % 2 === 0, elapsed_seconds: 3.2 + i * 0.1},
      {...base, baseline: 'synced_deterministic', status: 'completed', prediction: truth, elapsed_seconds: 3.6 + i * 0.12, evidence},
      {...base, baseline: 'synced_twinhunter', status: i === 7 ? 'inconclusive' : 'completed', prediction: hunterPrediction, elapsed_seconds: 14 + i * 1.7,
        trace, evidence: i === 4 ? [] : evidence, reported_tokens: 4200 + i * 610},
    ]
  })
  const patch = (label: string, seeded: string, checks: Record<string, unknown>) => ({label, seeded_case: seeded, source_snapshot: hex(90), checks,
    diff: `--- source\n+++ candidate\n@@ -3,4 +3,4 @@\n-  "protected-mode": "no"\n+  "protected-mode": "yes"`, rollback: {restore: hex(90)}, limitations: ['synthetic workflow only']})
  return {schema_version: '3.0', run_id: DEMO_REPORT_ID, created_at: minutesAgo(300), mode: 'demo_synthetic', manifest_hash: hex(77),
    model_lock: {model: 'synthetic demo — not a measured model'}, environment: {note: 'generated in the browser for UI review'}, budgets: {max_steps: 12},
    limitations: ['Every value in this report is synthetic demo data.', 'It must not be cited as TwinHunter performance.'], rows,
    patches: [
      patch('verified in the tested twin scenario', 'valid', {original_security: {verdict: 'confirmed'}, original_workflow: true, syntax_and_startup: true, security_retest: {verdict: 'not_reproduced'}, legitimate_workflow: true, cleanup: true}),
      patch('rejected', 'breaking', {original_security: {verdict: 'confirmed'}, original_workflow: true, syntax_and_startup: true, security_retest: {verdict: 'not_reproduced'}, legitimate_workflow: false, cleanup: true}),
      patch('rejected', 'ineffective', {original_security: {verdict: 'confirmed'}, original_workflow: true, syntax_and_startup: true, security_retest: {verdict: 'confirmed'}, legitimate_workflow: true, cleanup: true}),
      patch('rejected', 'invalid', {original_security: {verdict: 'confirmed'}, original_workflow: true, syntax_and_startup: false}),
    ]}
}
export const demoResearch = {id: DEMO_REPORT_ID, list: () => [{id: DEMO_REPORT_ID, mode: 'demo_synthetic', created_at: minutesAgo(300), manifest_hash: 'demo'}], report: demoReport}
