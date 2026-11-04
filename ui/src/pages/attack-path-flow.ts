// Timing is internal to the demo; the UI only shows the current activity.
import type {Assessment, Host, Topology} from '../types'

export const SCAN_DURATION_MS = 180_000
export const SCAN_STAGE_COUNT = 4

const recentGenerations = new Map<string, string>()

/** A re-enrolled host has a new agent ID, even if its name and routes are identical. */
export function twinGeneration(hosts: Host[], topology: Topology): string {
  const active = hosts.filter(host => !host.revoked_at).map(host => host.agent_id).sort()
  const graphHosts = topology.nodes.filter(node => node.labels.includes('Host'))
    .map(node => String(node.properties.agent_id ?? node.id)).sort()
  return JSON.stringify({active, graphHosts})
}

export function lastScannedGeneration(key: string): string | null {
  try { return localStorage.getItem(`twinhunter.scan.${key}`) ?? recentGenerations.get(key) ?? null }
  catch { return recentGenerations.get(key) ?? null }
}

export function rememberScannedGeneration(key: string, generation: string): void {
  recentGenerations.set(key, generation)
  try { localStorage.setItem(`twinhunter.scan.${key}`, generation) } catch { /* Storage may be unavailable. */ }
}

export function showCandidateRoutes(sourceVulnerable: boolean, previousGeneration: string | null, currentGeneration: string): boolean {
  return sourceVulnerable || previousGeneration !== null && previousGeneration !== currentGeneration
}

/** A connectivity example for the manual preview when no attack-path candidates exist. */
export function topologyPreviewRoute(topology: Topology): Assessment | null {
  const nodes = new Map(topology.nodes.map(node => [node.id, node]))
  const edges = topology.edges.filter(edge =>
    (edge.kind === 'OBSERVED_CONNECTION' || edge.kind === 'INFERRED_REACHABILITY') &&
    edge.source !== edge.target && nodes.has(edge.source) && nodes.has(edge.target))
  const hosts = topology.nodes.filter(node => node.labels.includes('Host'))
  const starts = [...hosts].sort((a, b) =>
    Number(Boolean(b.properties.entry)) - Number(Boolean(a.properties.entry)) ||
    Number(/web/i.test(String(b.properties.hostname ?? ''))) - Number(/web/i.test(String(a.properties.hostname ?? ''))))
  let chosen: typeof edges = []
  for (const start of starts) {
    const route: typeof edges = []
    const seen = new Set([start.id])
    let current = start.id
    while (route.length < 3) {
      const next = edges.find(edge => edge.source === current && !seen.has(edge.target))
      if (!next) break
      route.push(next); seen.add(next.target); current = next.target
    }
    if (route.length > chosen.length) chosen = route
  }
  if (!chosen.length) return null
  const routeNodes = [chosen[0].source, ...chosen.map(edge => edge.target)]
  return {id: `preview-topology-${routeNodes.join('-')}`, nodes: routeNodes, hop_count: chosen.length,
    review_order: 1, issues: [], validation_status: 'unvalidated', confirmed_hops: 0,
    steps: chosen.map(edge => ({source: edge.source, target: edge.target, kind: edge.kind,
      observed_at: typeof edge.properties.observed_at === 'string' ? edge.properties.observed_at : null,
      evidence_source: typeof edge.properties.evidence_source === 'string' ? edge.properties.evidence_source : null,
      freshness: 'unknown'})),
    next_action: 'This is a connectivity preview only. Identify entry and critical assets, then validate each hop.'}
}

export function scanState(startedAt: number, now: number) {
  const elapsed = Math.max(0, now - startedAt)
  return {
    step: Math.min(SCAN_STAGE_COUNT - 1, Math.floor(elapsed / (SCAN_DURATION_MS / SCAN_STAGE_COUNT))),
    complete: elapsed >= SCAN_DURATION_MS,
  }
}
