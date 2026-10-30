/** Same-origin API client. Demo mode (VITE_DEMO=1, development only) swaps in a synthetic backend. */
export const DEMO = import.meta.env.DEV && import.meta.env.VITE_DEMO === '1'

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const init: RequestInit = {method, cache: 'no-store', headers: {...(body !== undefined ? {'content-type': 'application/json'} : {}), ...headers},
    body: body !== undefined ? JSON.stringify(body) : undefined}
  // The demo module is only fetched in development demo mode; production builds drop this branch.
  const response = DEMO ? await (await import('./demo')).demoFetch(method, path, body) : await fetch(path, init)
  if (!response.ok) {
    const detail = await response.json().then((x: {detail?: unknown}) => x.detail, () => undefined)
    throw new ApiError(response.status, typeof detail === 'string' ? detail : `Request failed (${response.status})`)
  }
  return response.json() as Promise<T>
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown, headers?: Record<string, string>) => request<T>('POST', path, body, headers),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
}

/** Live graph updates for the session's tenant. Returns a disposer. */
export function subscribe(onUpdate: () => void): () => void {
  if (DEMO) return () => {}
  const events = new EventSource('/api/events')
  events.addEventListener('graph_updated', onUpdate)
  return () => events.close()
}

export const message = (error: unknown) => error instanceof Error ? error.message : String(error)
