import {useCallback, useEffect, useState} from 'react'
import {api, message, subscribe} from './api'
import type {Agent, Topology} from './types'

export type TwinData = {agents: Agent[]; topology: Topology; error: string; updated: Date | null; loading: boolean; refresh: () => Promise<void>}

/** Inventory and topology for the session's tenant, refreshed on live graph events. */
export function useTwinData(): TwinData {
  const [agents, setAgents] = useState<Agent[]>([])
  const [topology, setTopology] = useState<Topology>({nodes: [], edges: []})
  const [error, setError] = useState(''), [updated, setUpdated] = useState<Date | null>(null), [loading, setLoading] = useState(true)
  const refresh = useCallback(async () => {
    try {
      const [inventory, graph] = await Promise.all([api.get<Agent[]>('/api/inventory'), api.get<Topology>('/api/topology')])
      setAgents(inventory); setTopology(graph); setUpdated(new Date()); setError('')
    } catch (e) { setError(message(e)) } finally { setLoading(false) }
  }, [])
  useEffect(() => {
    void refresh()
    const timer = setInterval(refresh, 30000)
    const dispose = subscribe(() => void refresh())
    return () => { clearInterval(timer); dispose() }
  }, [refresh])
  return {agents, topology, error, updated, loading, refresh}
}

export const hostName = (topology: Topology, id: string) => {
  const node = topology.nodes.find(n => n.id === id)
  return String(node?.properties.hostname ?? (id.includes(':') ? id.split(':').slice(-2).join(':') : id.slice(0, 12)))
}

export const serviceInfo = (data: unknown): {name: string; version?: string} => {
  try { const parsed = JSON.parse(String(data ?? '{}')); return {name: String(parsed.name ?? 'service'), version: parsed.version} } catch { return {name: 'service'} }
}

export const ago = (iso: string | null | undefined) => {
  if (!iso) return 'never'
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}
