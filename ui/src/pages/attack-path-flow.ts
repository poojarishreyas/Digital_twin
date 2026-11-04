// Timing is internal to the demo; the UI only shows the current activity.
import type {Host, Topology} from '../types'

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

export function scanState(startedAt: number, now: number) {
  const elapsed = Math.max(0, now - startedAt)
  return {
    step: Math.min(SCAN_STAGE_COUNT - 1, Math.floor(elapsed / (SCAN_DURATION_MS / SCAN_STAGE_COUNT))),
    complete: elapsed >= SCAN_DURATION_MS,
  }
}
