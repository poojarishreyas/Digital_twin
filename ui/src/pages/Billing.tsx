import {useCallback, useEffect, useState} from 'react'
import {api, message} from '../api'
import {useSession} from '../auth'
import type {Billing as BillingData} from '../types'
import {Icon} from '../ui/icons'

const money = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`

export function Billing() {
  const {principal} = useSession()
  const [data, setData] = useState<BillingData | null>(null)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    try { setData(await api.get<BillingData>('/api/billing')); setError('') } catch (e) { setError(message(e)) }
  }, [])
  useEffect(() => { void load() }, [load])

  async function checkout(plan: 'starter' | 'business', outcome: 'succeeded' | 'failed') {
    setBusy(true); setNotice('')
    try {
      await api.post('/api/billing/demo-checkout', {plan, outcome})
      setNotice(outcome === 'succeeded' ? 'Demo payment succeeded. Your subscription was updated.' : 'Demo payment failed. Your subscription was not changed.')
      await load()
    } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }

  return <>
    <div className="page-head"><div><span className="eyebrow"><Icon name="building" size={14}/>SaaS billing</span><h1>Subscription</h1>
      <p>Simulated payments for the BEA project. No card details are collected and no money is charged.</p></div></div>
    {error && <div className="alert danger" role="alert">{error}</div>}
    {notice && <div className="alert info" role="status">{notice}</div>}
    <section className="card card-body"><h2>Current subscription</h2>
      <p>{data?.subscription ? <><b>{data.subscription.plan}</b> · {data.subscription.status} · period ends {new Date(data.subscription.current_period_end).toLocaleDateString()}</> : 'Loading…'}</p></section>
    <section className="card card-body"><h2>Demo plans</h2><p>Monthly prices are illustrative.</p>
      <div className="row" style={{gap: 18}}>{([['starter', 49900], ['business', 149900]] as const).map(([plan, price]) =>
        <div key={plan} className="card card-body" style={{minWidth: 220, flex: 1}}><h3 style={{textTransform: 'capitalize'}}>{plan}</h3><p>{money(price)} / month</p>
          {principal.role === 'admin' && <div className="row"><button className="btn primary" disabled={busy} onClick={() => void checkout(plan, 'succeeded')}>Simulate payment</button>
            <button className="btn" disabled={busy} onClick={() => void checkout(plan, 'failed')}>Simulate failure</button></div>}</div>)}</div>
      {principal.role !== 'admin' && <p className="muted">A company admin can change the demo plan.</p>}</section>
    <section className="card"><div className="card-head"><h2>Demo payment history</h2></div>
      <div className="table-wrap"><table className="table"><thead><tr><th>Date</th><th>Plan</th><th>Amount</th><th>Status</th><th>By</th></tr></thead>
        <tbody>{data?.payments.map(p => <tr key={p.id}><td>{new Date(p.created_at).toLocaleString()}</td><td>{p.plan}</td><td>{money(p.amount_paise)}</td>
          <td><span className={`chip ${p.status === 'succeeded' ? 'ok' : 'danger'}`}>{p.status}</span></td><td>{p.created_by}</td></tr>)}</tbody></table></div>
      {data?.payments.length === 0 && <p className="muted" style={{padding: 16}}>No demo payments yet.</p>}</section>
  </>
}
