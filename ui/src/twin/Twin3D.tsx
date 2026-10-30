import {forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode} from 'react'
import type {Topology} from '../types'
import {TwinEngine, type SimulationWave} from './engine'
import {Icon} from '../ui/icons'

export type TwinHandle = {
  playAttack: (nodes: string[], isolated: string | null, onStep: (hop: number) => void) => Promise<'reached' | 'blocked' | 'cancelled'>
  playSimulation: (waves: SimulationWave[], onPhase: Parameters<TwinEngine['playSimulation']>[1]) => Promise<void>
  stop: () => void
  focus: (id: string) => void
  setSpeed: (speed: number) => void
}

type Props = {topology: Topology; selected: string | null; onSelect: (id: string | null) => void; height?: number | string
  children?: ReactNode; legend?: boolean; className?: string}

function webglAvailable() {
  try { const c = document.createElement('canvas'); return Boolean(c.getContext('webgl2') || c.getContext('webgl')) } catch { return false }
}

export const Twin3D = forwardRef<TwinHandle, Props>(function Twin3D({topology, selected, onSelect, height = 560, children, legend = true, className = ''}, ref) {
  const host = useRef<HTMLDivElement>(null)
  const engine = useRef<TwinEngine | null>(null)
  const select = useRef(onSelect)
  const [rotating, setRotating] = useState(false)
  const [supported] = useState(webglAvailable)
  select.current = onSelect

  useEffect(() => {
    if (!host.current || !supported) return
    engine.current = new TwinEngine(host.current, id => select.current(id))
    return () => { engine.current?.dispose(); engine.current = null }
  }, [supported])
  useEffect(() => { engine.current?.setTopology(topology) }, [topology])
  useEffect(() => { engine.current?.setSelected(selected) }, [selected])

  useImperativeHandle(ref, () => ({
    playAttack: (nodes, isolated, onStep) => engine.current?.playAttack(nodes, isolated, onStep) ?? Promise.resolve('cancelled' as const),
    playSimulation: (waves, onPhase) => engine.current?.playSimulation(waves, onPhase) ?? Promise.resolve(),
    stop: () => engine.current?.stopAll(),
    focus: id => engine.current?.focus(id),
    setSpeed: speed => { if (engine.current) engine.current.speed = speed },
  }), [])

  const hosts = topology.nodes.filter(n => n.labels.includes('Host')).length
  return <div className={`twin ${className}`} style={{height}}>
    <div ref={host} className="twin-stage" aria-label="3D infrastructure twin. Drag to orbit, scroll to zoom, click an asset to inspect it." role="img"/>
    {!supported && <div className="twin-empty"><Icon name="cube"/><b>3D view unavailable</b><span>This browser has WebGL disabled.</span></div>}
    {supported && hosts === 0 && <div className="twin-empty"><Icon name="cube"/><b>No assets in this workspace yet</b><span>Enroll an agent for this tenant to build its twin.</span></div>}
    <div className="twin-tools">
      <button className="icon-btn" title="Reset view" aria-label="Reset view" onClick={() => engine.current?.resetCamera()}><Icon name="target"/></button>
      <button className={`icon-btn ${rotating ? 'on' : ''}`} title="Auto-rotate" aria-label="Toggle auto-rotate" aria-pressed={rotating}
        onClick={() => { engine.current?.setAutoRotate(!rotating); setRotating(!rotating) }}><Icon name="orbit"/></button>
    </div>
    {legend && <div className="twin-legend">
      <span><i className="ln observed"/>Observed</span><span><i className="ln inferred"/>Inferred</span><span><i className="ln confirmed"/>Confirmed</span>
      <span><i className="dot entry"/>Entry</span><span><i className="dot critical"/>Critical</span>
    </div>}
    {children}
  </div>
})
