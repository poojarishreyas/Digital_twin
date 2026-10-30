import {useEffect, useState} from 'react'
import {api, message} from '../api'
import {tenantColor, useSession} from '../auth'
import type {TenantInfo} from '../types'
import {Icon} from '../ui/icons'
import type {TwinData} from '../useTwinData'

const ISOLATION: Record<string, [string, string]> = {
  graph: ['Graph twin', 'Every node carries a tenant-scoped unique key; shared endpoints never merge across workspaces.'],
  history: ['Run & ingestion history', 'Receipts, metrics, gaps, plans, runs and reports are keyed and queried by tenant.'],
  events: ['Live events', 'Server-sent updates are partitioned per tenant and re-authorized on every event.'],
  sandbox: ['Sandbox twins', 'Disposable services run on per-run internal networks labeled with the owning tenant.'],
}

export function Workspace({data}: {data: TwinData}) {
  const {principal} = useSession()
  const [info, setInfo] = useState<TenantInfo | null>(null), [error, setError] = useState('')
  useEffect(() => { api.get<TenantInfo>('/api/tenant').then(setInfo).catch(e => setError(message(e))) }, [])
  const membership = principal.tenants.find(t => t.id === principal.tenant)

  return <>
    <div className="page-head">
      <div><span className="eyebrow"><Icon name="building" size={14}/>Workspace</span><h1>Tenant settings & isolation</h1>
        <p>This workspace is a logically isolated tenant on a shared control plane. Your role here is independent of your role in other workspaces.</p></div>
    </div>
    {error && <div className="alert danger"><Icon name="alert"/>{error}</div>}
    <div className="grid-2">
      <div className="stack">
        <section className="card card-pad row" style={{gap: 16}}>
          <span className="tenant-avatar" style={{background: tenantColor(principal.tenant), width: 56, height: 56, fontSize: 20, borderRadius: 14}}>{(membership?.name ?? principal.tenant).slice(0, 2).toUpperCase()}</span>
          <div style={{flex: 1}}><h2 style={{fontSize: 19}}>{info?.name ?? membership?.name ?? principal.tenant}</h2>
            <div className="row" style={{gap: 6, marginTop: 4}}><span className="chip mono">{principal.tenant}</span>
              <span className={`chip ${info?.status === 'suspended' ? 'danger' : 'ok'}`}><span className="dot"/>{info?.status ?? 'active'}</span>
              <span className="chip accent">you: {principal.role}</span></div></div>
        </section>
        <section className="card" aria-label="Isolation guarantees">
          <div className="card-head"><div><h2>Isolation model</h2><p>Enforced server-side on every request, independent of the browser</p></div><Icon name="shieldCheck"/></div>
          <div className="list">{Object.entries(ISOLATION).map(([key, [title, text]]) => <div key={key} className="list-row" style={{cursor: 'default', alignItems: 'flex-start'}}>
            <span className="os-badge" style={{background: 'var(--ok-soft)', color: 'var(--ok)'}}><Icon name="lock" size={16}/></span>
            <span className="meta"><b>{title}</b><small style={{whiteSpace: 'normal'}}>{text}</small></span>
            {info?.isolation[key] && <span className="chip mono" style={{fontSize: 10.5}}>{info.isolation[key]}</span>}</div>)}</div>
        </section>
        <section className="card" aria-label="Enrolled agents">
          <div className="card-head"><div><h2>Agent enrollment</h2><p>Agents are bound to exactly one tenant by certificate identity</p></div>
            <span className="chip">{info?.registered_agents ?? '…'} registered</span></div>
          <div className="card-body stack" style={{gap: 10}}>
            {info?.accepts_unregistered_agents ? <div className="alert warn"><Icon name="alert"/>This workspace accepts telemetry from unregistered agents (single-company upgrade mode). Register each agent and disable the fallback to enforce deny-by-default.</div>
              : <div className="alert info"><Icon name="shieldCheck"/>Deny-by-default: telemetry from agents not registered to this tenant is refused before it reaches storage.</div>}
            <pre className="code">{`python deploy/auth/tenants.py register-agent <certificate-CN> --tenant ${principal.tenant}`}</pre>
            <small className="muted">{data.agents.length} agents have reported into this workspace.</small>
          </div>
        </section>
      </div>
      <div className="stack">
        <section className="card" aria-label="Quotas">
          <div className="card-head"><div><h2>Quotas</h2><p>Fair-share limits for the shared sandbox</p></div><Icon name="sliders"/></div>
          <div className="card-body stack" style={{gap: 14}}>{info ? [
            ['Concurrent runs', info.quotas.max_pending_runs, 'queued or running per workspace'],
            ['CPU per run', `${info.quotas.max_run_cpu_millis}m`, 'millicores across a wave'],
            ['RAM per run', `${info.quotas.max_run_ram_mb} MB`, 'summed service bundles'],
            ['Path depth', info.quotas.max_path_depth, 'maximum hops analyzed']].map(([label, value, note]) =>
            <div key={String(label)} className="row between"><span><b style={{fontSize: 13}}>{label}</b><small className="muted" style={{display: 'block', fontSize: 12}}>{note}</small></span><b className="mono">{value}</b></div>)
            : [0, 1, 2, 3].map(i => <div key={i} className="skeleton" style={{height: 34}}/>)}</div>
        </section>
        <section className="card" aria-label="Your memberships">
          <div className="card-head"><div><h2>Your memberships</h2><p>Switch from the workspace menu in the top bar</p></div><Icon name="users"/></div>
          <div className="list">{principal.tenants.map(t => <div key={t.id} className={`list-row ${t.id === principal.tenant ? 'active' : ''}`} style={{cursor: 'default'}}>
            <span className="tenant-avatar" style={{background: tenantColor(t.id), width: 28, height: 28, fontSize: 11}}>{t.name.slice(0, 2).toUpperCase()}</span>
            <span className="meta"><b>{t.name}</b><small>{t.id}</small></span><span className="chip">{t.role}</span></div>)}</div>
        </section>
      </div>
    </div>
  </>
}
