import {useEffect, useState} from 'react'
import {api, message} from './api'

export type CodebaseSnapshot = {
  url: string; slug: string; branch: string; commit: string; vulnerable: boolean; status: 'vulnerable' | 'fixed'
  scenario: string; file: string; verified_at: string; diff: string; validation: string
  pr?: {url: string; number: number; branch: string; status: string; base_commit: string}
}
export type CodebaseConnection = {codebase: CodebaseSnapshot | null; pr_enabled: boolean}

export function useCodebase() {
  const [connection, setConnection] = useState<CodebaseConnection>({codebase: null, pr_enabled: false})
  const [loading, setLoading] = useState(true), [error, setError] = useState('')
  useEffect(() => {
    let live = true
    api.get<CodebaseConnection>('/api/codebase').then(value => { if (live) { setConnection(value); setError('') } })
      .catch(e => { if (live) setError(message(e)) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [])
  async function refresh() {
    const value = await api.post<CodebaseConnection>('/api/codebase/refresh', {})
    setConnection(value); setError(''); return value
  }
  return {connection, setConnection, loading, error, refresh}
}
