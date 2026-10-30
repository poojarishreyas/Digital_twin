import {useMemo, useRef, useState} from 'react'
import {Twin3D, type TwinHandle} from '../twin/Twin3D'
import {Icon} from '../ui/icons'
import {Inspector, type PageProps} from '../ui/Inspector'
import {hostName, serviceInfo} from '../useTwinData'

export function Explorer({data, selected, onSelect}: PageProps) {
  const twin = useRef<TwinHandle>(null)
  const [query, setQuery] = useState('')
  const {topology} = data
  const assets = useMemo(() => topology.nodes.filter(n => n.labels.includes('Host') || n.properties.kind === 'service').map(n => ({
    id: n.id, host: n.labels.includes('Host'),
    name: n.labels.includes('Host') ? hostName(topology, n.id) : `${serviceInfo(n.properties.data_json).name} ${serviceInfo(n.properties.data_json).version ?? ''}`,
    parent: topology.edges.find(e => e.target === n.id && e.kind === 'HAS_SERVICE')?.source,
    entry: Boolean(n.properties.entry), critical: Boolean(n.properties.critical),
  })), [topology])
  const filtered = assets.filter(a => `${a.name} ${a.id} ${a.parent ? hostName(topology, a.parent) : ''}`.toLowerCase().includes(query.toLowerCase()))
  const edges = topology.edges.filter(e => !e.kind.startsWith('HAS_') && e.kind !== 'INSTANCE_OF')
  const pick = (id: string) => { onSelect(id); twin.current?.focus(id) }

  return <>
    <div className="page-head">
      <div><span className="eyebrow"><Icon name="cube" size={14}/>Digital twin</span><h1>3D infrastructure twin</h1>
        <p>Hosts are arranged by reachability from entry points — perimeter on the left, crown jewels on the right. Service modules stack on each host; arcs carry observed and inferred traffic.</p></div>
      <div className="row"><span className="chip">{assets.filter(a => a.host).length} hosts</span><span className="chip">{assets.filter(a => !a.host).length} services</span><span className="chip">{edges.length} connections</span></div>
    </div>
    <div className="split explorer">
      <section className="card" aria-label="Asset list" style={{maxHeight: 'calc(100vh - 210px)', display: 'flex', flexDirection: 'column'}}>
        <div className="card-body" style={{borderBottom: '1px solid var(--border)'}}>
          <input className="input" style={{width: '100%'}} placeholder="Search hosts and services" aria-label="Search assets" value={query} onChange={e => setQuery(e.target.value)}/>
        </div>
        <div className="list" style={{overflow: 'auto'}}>
          {filtered.length === 0 && <div className="empty"><b>No matches</b></div>}
          {filtered.map(a => <button key={a.id} className={`list-row ${selected === a.id ? 'active' : ''}`} style={{paddingLeft: a.host ? 20 : 40}} onClick={() => pick(a.id)}>
            <span className="os-badge" style={a.host ? undefined : {width: 26, height: 26}}><Icon name={a.host ? 'server' : 'layers'} size={a.host ? 16 : 13}/></span>
            <span className="meta"><b>{a.name}</b><small>{a.host ? a.id.slice(0, 14) : `on ${a.parent ? hostName(topology, a.parent) : 'unknown host'}`}</small></span>
            {a.entry && <span className="chip info">Entry</span>}{a.critical && <span className="chip violet">Critical</span>}
          </button>)}
        </div>
      </section>
      <Twin3D ref={twin} topology={topology} selected={selected} onSelect={onSelect} height="calc(100vh - 210px)"/>
      <section className="card card-pad" aria-label="Asset inspector" style={{maxHeight: 'calc(100vh - 210px)', overflow: 'auto'}}>
        <Inspector data={data} selected={selected} onSelect={onSelect} onFocus={id => twin.current?.focus(id)}/>
      </section>
    </div>
  </>
}
