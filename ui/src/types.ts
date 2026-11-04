export type Role = 'viewer' | 'operator' | 'admin'
export type TenantRef = {id: string; name: string; role: Role}
export type Principal = {id: string; role: Role; tenant: string; tenants: TenantRef[]; auth_mode: 'tokens' | 'lab'
  platform_admin?: boolean; kind?: 'token' | 'password'; display_name?: string}

export type Customer = {id: string; name: string; status: 'active' | 'suspended'; managed_by: 'file' | 'database'; members: number
  enrolled_agents: number; known_agents: number; reporting_agents: number; last_report: string | null; runs: number; active_runs: number
  pending_invites: number; created_at: string | null}
export type InviteResult = {invite_token: string; invite: {id: string; tenant_id: string | null; role: Role | null; expires_at: string}}
export type Billing = {subscription: null | {plan: 'trial' | 'starter' | 'business'; status: 'trialing' | 'active'; current_period_end: string; updated_at: string}
  payments: {id: string; plan: 'starter' | 'business'; amount_paise: number; currency: 'INR'; status: 'succeeded' | 'failed'; created_by: string; created_at: string}[]}
export type EnrollmentToken = {id: string; label: string; created_by: string; created_at: string; expires_at: string; max_uses: number
  uses: number; revoked: boolean; usable: boolean}
export type Host = {agent_id: string; hostname: string; os: string; enrolled_at: string; certificate_expires_at: string
  revoked_at: string | null; revoked_by: string | null; last_seen: string | null; last_sequence: number | null}
export type TeamMember = {id: string; display_name: string; role: Role; last_login?: string | null; joined_at?: string; managed_by: 'file' | 'database'}
export type PendingInvite = {id: string; role: Role; label: string; created_by: string; created_at: string; expires_at: string}

export type TenantInfo = {
  id: string; name: string; status: 'active' | 'suspended'; registered_agents: number; accepts_unregistered_agents: boolean
  managed_by?: 'file' | 'database'
  quotas: {max_pending_runs: number; max_run_cpu_millis: number; max_run_ram_mb: number; max_path_depth: number}
  isolation: Record<string, string>
}

export type Gap = {collector: string; field: string; reason: string; detail: string}
export type Agent = {agent_id: string; last_sequence: number; last_seen: string; needs_full: boolean; stale: boolean; gaps: Gap[]}
export type GraphNode = {id: string; labels: string[]; properties: Record<string, unknown>}
export type GraphEdge = {source: string; target: string; kind: string; properties: Record<string, unknown>}
export type Topology = {nodes: GraphNode[]; edges: GraphEdge[]; truncated_nodes?: boolean; truncated_edges?: boolean}

export type PathConfirmation = {evidence_source: string | null; observed_at: string | null; basis: string[]; test_ids: string[]; run_id: string | null}
export type PathStep = {source: string; target: string; kind: string; observed_at: string | null; evidence_source: string | null; freshness: string; confirmed?: boolean; confirmation?: PathConfirmation}
export type PathIssue = {asset_id: string; reason: string; step?: number; gap_count?: number}
export type Assessment = {id: string; nodes: string[]; hop_count: number; steps: PathStep[]; review_order: number; issues: PathIssue[]; next_action: string
  validation_status?: 'unvalidated' | 'partially_confirmed' | 'proven'; confirmed_hops?: number
  remediation?: {service: string; change: string; retest: string; workflows: string}}
export type PathReport = {
  assessments: Assessment[]; warnings: string[]; ordering: string
  universe: {entries: string[]; critical: string[]; path_count: number; max_paths: number; max_states: number; truncated: boolean
    generated_at: string; assumptions: string[]; freshness_threshold_seconds: number}
  review_points: {asset_id: string; label: string; path_count: number}[]
  isolation_preview: null | {asset_id: string; affected_count: number; remaining_count: number; scope: string; limitation: string}
}

export type Verdict = 'confirmed' | 'not_reproduced' | 'inconclusive' | 'unsupported'
export type PlanWave = {index: number; service_ids: string[]; path_ids: string[]; cpu_millis: number; ram_mb: number}
export type Plan = {path_universe_size: number; planned_paths: number; untested_paths: number; excluded: {id: string; reason: string}[]
  waves: PlanWave[]; paths?: {id: string; nodes?: string[]}[]; budget?: {cpu_millis: number; ram_mb: number}}
export type Run = {id: string; status: string; created_at: string; cleanup_status: string; peak_cpu_millis: number; peak_ram_mb: number; plan?: Plan; error?: string}
export type Wave = {wave_index: number; status: string; service_ids: string[]; path_ids: string[]; health: Record<string, {ready?: boolean; isolation?: {passed: boolean}}>}
export type Finding = {id: string; target_id: string; test_id: string; verdict: Verdict; image_id: string; snapshot_hash: string
  fidelity_gaps: string[]; observations: Record<string, unknown>; recorded_at: string; wave_index?: number}
export type Hunt = {id: string; target_id: string; data: {status: string; reserved_tokens: number; reported_tokens: number | null; trace: unknown[]; evidence: unknown[]; patches: unknown[]}}
export type RunDetail = {run: Run; waves: Wave[]; findings: Finding[]; validated_path_ids: string[]; unvalidated_path_ids: string[]; hunts?: Hunt[]}

export type AuditRow = {id: number | string; recorded_at: string; actor: string; role: string; action: string; stage: string; status: number | null; request_id: string}
