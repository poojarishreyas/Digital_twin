import {useState} from 'react'
import {api, message} from '../api'
import {useSession} from '../auth'
import {useCodebase, type CodebaseConnection} from '../codebase'
import {Icon} from '../ui/icons'

export function Codebase({go}: {go: (page: string) => void}) {
  const {principal} = useSession()
  const {connection, setConnection, loading, error: loadError, refresh} = useCodebase()
  const [url, setUrl] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const source = connection.codebase
  async function connect() {
    setBusy(true); setError('')
    try { setConnection(await api.put<CodebaseConnection>('/api/codebase', {url: url.trim()})); setUrl('') }
    catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  async function sync() {
    setBusy(true); setError('')
    try { await refresh() } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  return <>
    <div className="page-head"><div><span className="eyebrow"><Icon name="file" size={14}/>Source integration</span><h1>Codebase</h1>
      <p>Connect the application repository before starting an attack-path analysis. Repairs are proposed as pull requests.</p></div></div>
    {(error || loadError) && <div className="alert danger" role="alert">{error || loadError}</div>}
    <div className="grid-2">
      <section className="card"><div className="card-head"><div><h2>GitHub repository</h2><p>Workspace-scoped source, pinned to an exact commit</p></div><Icon name="file"/></div>
        <div className="card-body stack">
          {principal.role === 'admin' && <form className="stack" onSubmit={event => { event.preventDefault(); void connect() }}>
            <label className="field">Repository URL<input className="input" type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://github.com/owner/larkspur-vulnerable-shop" required/></label>
            <button className="btn primary" disabled={busy || loading || !url.trim()}><Icon name="plus" size={15}/>{busy ? 'Checking repository…' : source ? 'Connect another repository' : 'Connect repository'}</button>
          </form>}
          {loading ? <p className="muted">Loading codebase…</p> : !source ? <div className="empty"><Icon name="lock"/><b>Codebase required</b><span>{principal.role === 'admin' ? 'Add the GitHub link after uploading the Desktop lab project.' : 'A workspace administrator must connect a codebase.'}</span></div> : <>
            <div className="row between"><a href={source.url} target="_blank" rel="noreferrer"><b>{source.slug} ↗</b></a><span className={`chip ${source.vulnerable ? 'danger' : 'ok'}`}>{source.vulnerable ? 'Vulnerable source' : 'Repair present in source'}</span></div>
            <div className="report-metadata"><div><small>Branch</small><b>{source.branch}</b></div><div><small>Commit</small><b className="mono">{source.commit.slice(0, 12)}</b></div><div><small>File</small><b>{source.file}</b></div><div><small>Last verified</small><b>{new Date(source.verified_at).toLocaleString()}</b></div></div>
            <p className="muted">{source.validation}</p>
            <div className="row">{principal.role !== 'viewer' && <button className="btn" disabled={busy} onClick={() => void sync()}><Icon name="refresh" size={15}/>Refresh source</button>}
              <button className="btn primary" disabled={busy} onClick={() => go('paths')}><Icon name="route" size={15}/>Analyze attack paths</button></div>
            {source.pr && <div className="alert info"><Icon name="file"/><div><a href={source.pr.url} target="_blank" rel="noreferrer">Review repair pull request #{source.pr.number} ↗</a><p>Merge the repair, then refresh source to verify the default branch.</p></div></div>}
            {source.diff && <details className="disclosure"><summary>Proposed authentication repair</summary><div><pre className="code diff">{source.diff}</pre></div></details>}
          </>}
        </div>
      </section>
      <section className="card card-pad stack"><h2>Source → review → deployment</h2>
        <ol className="steps"><li><b>Connect source</b><p className="muted">Public GitHub repositories can be inspected without credentials. This release supports the supplied Larkspur lab.</p></li>
          <li><b>Analyze the pinned commit</b><p className="muted">The three-minute walkthrough combines a source finding with your topology context.</p></li>
          <li><b>Review a real fix</b><p className="muted">Fix now changes app.py on a new branch and opens a PR. It never merges automatically.</p></li>
          <li><b>Merge, refresh, deploy</b><p className="muted">Refresh checks the default branch after merge. AWS deployment and live validation remain separate.</p></li></ol>
        <div className={`alert ${connection.pr_enabled ? 'info' : 'warn'}`}><Icon name="lock"/><span>{connection.pr_enabled ? 'GitHub PR access is configured for this workspace and repository.' : 'PR creation needs GitHub write access. A platform administrator must configure the workspace integration. Adding a URL grants read access to public source only.'}</span></div>
      </section>
    </div>
  </>
}
