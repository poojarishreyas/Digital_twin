/**
 * Imperative three.js engine for the 3D infrastructure twin.
 *
 * Layout: hosts are placed in tiers by directed reachability from declared entry
 * assets (perimeter → internal → crown jewels). Each host is a platform with its
 * services stacked as modules. Connectivity edges are arcs with flowing traffic.
 *
 * Two choreographed modes sit on top of the live twin:
 *  - attack replay: a comet travels a candidate path hop by hop, breaching hosts,
 *    stopping at an isolation shield or raising an alarm at the critical target;
 *  - emulation replay: service modules are cloned into a floating, tenant-scoped
 *    sandbox wave by wave, probed, given verdicts and torn down.
 * Both are visualizations of recorded/candidate data, not live exploitation.
 */
import * as THREE from 'three'
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js'
import {CSS2DObject, CSS2DRenderer} from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import {RoundedBoxGeometry} from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import {mergeGeometries} from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type {Topology, Verdict} from '../types'

export const COLORS = {
  observed: 0x0d9488, inferred: 0xd97706, confirmed: 0xe11d48, attack: 0xe11d48, entry: 0x2563eb, critical: 0x7c3aed,
  shield: 0x3b82f6, sandbox: 0x6366f1, platform: 0xffffff, ground: 0xeef2f8, grid: 0xd5dde9,
}
export const VERDICT_COLORS: Record<Verdict, number> = {confirmed: 0xe11d48, not_reproduced: 0x16a34a, inconclusive: 0xd97706, unsupported: 0x94a3b8}
const SERVICE_COLORS: Record<string, number> = {nginx: 0x10b981, postgresql: 0x3b82f6, redis: 0xf97316, openssh: 0x64748b}
const LIVE_EDGES = new Set(['OBSERVED_CONNECTION', 'INFERRED_REACHABILITY', 'CONFIRMED_ATTACK_TRANSITION'])
const MODULE_H = 0.62, MODULE_GAP = 0.14, PLATFORM_H = 0.55

export type SimulationWave = {index: number; services: {id: string; verdict?: Verdict}[]}
type Tween = {start: number; duration: number; update: (p: number) => void; done?: () => void}
type HostVisual = {id: string; group: THREE.Group; platform: THREE.Mesh; material: THREE.MeshStandardMaterial; top: number
  label: CSS2DObject; base: THREE.Vector3; entry: boolean; critical: boolean}
type ModuleVisual = {id: string; host: string; mesh: THREE.Mesh; material: THREE.MeshStandardMaterial; kind: string}
type EdgeVisual = {source: string; target: string; kind: string; curve: THREE.QuadraticBezierCurve3; mesh: THREE.Mesh; material: THREE.MeshBasicMaterial; arrow: THREE.Mesh}

const ease = (p: number) => p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2
const easeOut = (p: number) => 1 - Math.pow(1 - p, 3)

function serviceKind(node: Topology['nodes'][number]): string {
  try { return String(JSON.parse(String(node.properties.data_json ?? '{}')).name ?? 'service') } catch { return 'service' }
}

// Only application-level services become 3D modules; OS housekeeping units (acpid, auditd,
// chronyd, ...) stay in the inspector list and are summarized as a count on the host label.
const NOTABLE = /^(nginx|httpd|apache2|haproxy|caddy|envoy|postgres(ql)?(-?\d+)?|mysqld?|mariadb|mongod|redis\d*(-server)?|valkey|memcached|rabbitmq(-server)?|kafka|elasticsearch|sshd|openssh|docker|containerd|kubelet|larkspur@.+|company-.+)$/
function notable(node: Topology['nodes'][number]): boolean {
  if (String(node.properties.evidence_source ?? '').startsWith('workload:')) return true
  return NOTABLE.test(serviceKind(node).replace(/\.service$/, ''))
}

function endpointIp(id: string): string | null {
  const match = /^endpoint:(.+):\d+$/.exec(id)
  return match ? match[1].replace(/^\[|\]$/g, '') : null
}

// Addresses that are never useful on the map: loopback, link-local (cloud metadata), unspecified.
function noiseIp(ip: string): boolean {
  return /^(127\.|169\.254\.|0\.0\.0\.0$|::1$|fe80:)/i.test(ip)
}

export class TwinEngine {
  readonly scene = new THREE.Scene()
  private renderer: THREE.WebGLRenderer
  private labels: CSS2DRenderer
  private camera: THREE.PerspectiveCamera
  private controls: OrbitControls
  private clock = new THREE.Clock()
  private frame = 0
  private tweens: Tween[] = []
  private world = new THREE.Group()
  private overlay = new THREE.Group()
  private hosts = new Map<string, HostVisual>()
  private modules = new Map<string, ModuleVisual>()
  private edges: EdgeVisual[] = []
  private particles: THREE.InstancedMesh | null = null
  private particleEdges: {edge: EdgeVisual; offset: number}[] = []
  private pickables: THREE.Object3D[] = []
  private selectionRing: THREE.Mesh
  private selected: string | null = null
  private hovered: THREE.Mesh | null = null
  private signature = ''
  private framed = false
  private bounds = new THREE.Box3()
  private generation = 0
  private observer: ResizeObserver
  private pointerDown = new THREE.Vector2()
  speed = 1

  constructor(private container: HTMLElement, private onSelect: (id: string | null) => void) {
    this.renderer = new THREE.WebGLRenderer({antialias: true, alpha: true, powerPreference: 'high-performance'})
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.domElement.className = 'twin-canvas'
    container.appendChild(this.renderer.domElement)
    this.labels = new CSS2DRenderer()
    this.labels.domElement.className = 'twin-labels'
    container.appendChild(this.labels.domElement)

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 600)
    this.camera.position.set(0, 42, 58)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    Object.assign(this.controls, {enableDamping: true, dampingFactor: 0.08, maxPolarAngle: 1.36, minDistance: 12, maxDistance: 180, autoRotateSpeed: 0.35})
    this.controls.addEventListener('start', () => { this.controls.autoRotate = false })

    this.scene.fog = new THREE.Fog(0xf3f6fb, 90, 220)
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xdfe6f0, 1.6))
    const sun = new THREE.DirectionalLight(0xffffff, 1.6)
    sun.position.set(24, 48, 30)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    Object.assign(sun.shadow.camera, {left: -80, right: 80, top: 80, bottom: -80, near: 1, far: 160})
    sun.shadow.radius = 6
    sun.shadow.bias = -0.0004
    this.scene.add(sun)
    const fill = new THREE.DirectionalLight(0xdbe4ff, 0.5)
    fill.position.set(-30, 20, -20)
    this.scene.add(fill)

    const ground = new THREE.Mesh(new THREE.CircleGeometry(260, 96), new THREE.MeshStandardMaterial({color: COLORS.ground, roughness: 1}))
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    this.scene.add(ground)
    const grid = new THREE.GridHelper(400, 100, COLORS.grid, COLORS.grid)
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.55
    grid.position.y = 0.01
    this.scene.add(grid)

    this.selectionRing = new THREE.Mesh(new THREE.TorusGeometry(2.7, 0.07, 12, 96), new THREE.MeshBasicMaterial({color: 0x4f46e5, transparent: true}))
    this.selectionRing.rotation.x = -Math.PI / 2
    this.selectionRing.visible = false
    this.scene.add(this.world, this.overlay, this.selectionRing)

    const canvas = this.renderer.domElement
    canvas.addEventListener('pointerdown', this.handleDown)
    canvas.addEventListener('pointerup', this.handleUp)
    canvas.addEventListener('pointermove', this.handleMove)
    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(container)
    this.resize()
    this.loop()
  }

  // ---------------------------------------------------------------- topology

  setTopology(topology: Topology) {
    const signature = JSON.stringify([topology.nodes.map(n => [n.id, n.properties.entry, n.properties.critical, n.properties.hostname]),
      topology.edges.map(e => [e.source, e.target, e.kind])])
    if (signature === this.signature) return
    this.signature = signature
    this.clearWorld()
    const byId = new Map(topology.nodes.map(n => [n.id, n]))
    const hostIds = topology.nodes.filter(n => n.labels.includes('Host')).map(n => n.id)
    // Addresses owned by enrolled hosts: a connection to one of them is drawn host-to-host
    // (resolved edges), so the raw "ip:ephemeral-port" endpoint would only add clutter.
    const owner = new Map<string, string>()
    for (const e of topology.edges) if (e.kind === 'HAS_LISTENER') {
      try {
        for (const ip of JSON.parse(String(byId.get(e.target)?.properties.data_json ?? '{}')).addresses ?? []) owner.set(String(ip), e.source)
      } catch { /* listener without address data */ }
    }
    const resolved = new Set(topology.edges.map(e => String(e.properties?.resolved_endpoint ?? '')).filter(Boolean))
    const hidden = (id: string) => {
      const ip = endpointIp(id)
      return ip !== null && (noiseIp(ip) || owner.has(ip) || resolved.has(id))
    }
    const live = topology.edges.filter(e => LIVE_EDGES.has(e.kind) && byId.has(e.source) && byId.has(e.target)
      && !hidden(e.source) && !hidden(e.target))
    // Non-host assets that take part in connectivity (endpoints) are drawn as small platforms.
    const placed = new Set(hostIds)
    for (const e of live) for (const id of [e.source, e.target]) if (!byId.get(id)!.labels.includes('Component')) placed.add(id)
    const services = new Map<string, string[]>()
    for (const e of topology.edges) if (e.kind === 'HAS_SERVICE' && placed.has(e.source) && byId.has(e.target)) {
      services.set(e.source, [...(services.get(e.source) ?? []), e.target])
    }

    const positions = this.layout([...placed], live, byId)
    for (const id of placed) this.buildHost(byId.get(id)!, positions.get(id)!, (services.get(id) ?? []).map(s => byId.get(s)!))
    for (const e of live) if (this.hosts.has(e.source) && this.hosts.has(e.target) && e.source !== e.target) this.buildEdge(e.source, e.target, e.kind)
    this.buildParticles()
    this.buildZones(positions, live.length > 0)
    // Frame the hosts themselves, not decorative zone bands or arc peaks.
    this.bounds.makeEmpty()
    for (const h of this.hosts.values()) this.bounds.expandByPoint(h.base)
    if (!this.bounds.isEmpty()) this.bounds.expandByVector(new THREE.Vector3(4, 3, 4))
    // Frame once, when the first non-empty graph arrives; later updates keep the user's view.
    if (!this.framed && this.hosts.size) { this.resetCamera(false); this.framed = true }
    this.setSelected(this.selected)
  }

  private layout(ids: string[], live: Topology['edges'], byId: Map<string, Topology['nodes'][number]>) {
    const tier = new Map<string, number>()
    const entries = ids.filter(id => byId.get(id)!.properties.entry)
    const incoming = new Set(live.map(e => e.target))
    const roots = entries.length ? entries : ids.filter(id => !incoming.has(id))
    const queue = roots.map(id => { tier.set(id, 0); return id })
    while (queue.length) {
      const id = queue.shift()!
      for (const e of live) if (e.source === id && !tier.has(e.target) && ids.includes(e.target)) { tier.set(e.target, tier.get(id)! + 1); queue.push(e.target) }
    }
    let max = Math.max(1, ...tier.values())
    for (const id of ids) if (!tier.has(id)) tier.set(id, Math.max(1, Math.floor(max / 2)))
    // Critical assets sit in the last tier: the "crown jewels" zone.
    for (const id of ids) if (byId.get(id)!.properties.critical) tier.set(id, Math.max(tier.get(id)!, max))
    max = Math.max(...tier.values())
    const columns = new Map<number, string[]>()
    for (const id of [...ids].sort()) columns.set(tier.get(id)!, [...(columns.get(tier.get(id)!) ?? []), id])
    const spacingX = 12.5, spacingZ = 8.5
    const result = new Map<string, THREE.Vector3>()
    for (const [t, column] of columns) column.forEach((id, i) => {
      const stagger = (t % 2) * spacingZ * 0.35
      result.set(id, new THREE.Vector3((t - max / 2) * spacingX, 0, (i - (column.length - 1) / 2) * spacingZ + stagger))
    })
    return result
  }

  private buildHost(node: Topology['nodes'][number], position: THREE.Vector3, services: Topology['nodes']) {
    const isHost = node.labels.includes('Host')
    const entry = Boolean(node.properties.entry), critical = Boolean(node.properties.critical)
    const group = new THREE.Group()
    group.position.copy(position)
    const size = isHost ? 3.4 : 2.2
    const material = new THREE.MeshStandardMaterial({color: isHost ? COLORS.platform : 0xf1f5f9, roughness: 0.42, metalness: 0.05, emissive: 0x000000})
    material.userData.base = material.color.getHex()
    const platform = new THREE.Mesh(new RoundedBoxGeometry(size, PLATFORM_H, size, 4, 0.18), material)
    platform.position.y = PLATFORM_H / 2
    platform.castShadow = platform.receiveShadow = true
    platform.userData.id = node.id
    group.add(platform)
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(size, PLATFORM_H, size)), new THREE.LineBasicMaterial({color: 0xcbd5e1, transparent: true, opacity: 0.6}))
    outline.position.y = PLATFORM_H / 2
    group.add(outline)
    this.pickables.push(platform)

    let top = PLATFORM_H
    const shown = services.filter(notable).slice(0, 8)
    const housekeeping = services.length - shown.length
    shown.forEach(service => {
      const kind = serviceKind(service), accent = SERVICE_COLORS[kind] ?? 0x8b5cf6
      const tint = new THREE.Color(0xffffff).lerp(new THREE.Color(accent), 0.32)
      const mat = new THREE.MeshStandardMaterial({color: tint, roughness: 0.35, metalness: 0.08, emissive: 0x000000})
      const mesh = new THREE.Mesh(new RoundedBoxGeometry(2.5, MODULE_H, 2.5, 3, 0.14), mat)
      mesh.position.y = top + MODULE_GAP + MODULE_H / 2
      mesh.castShadow = mesh.receiveShadow = true
      mesh.userData.id = service.id
      const led = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.12, 0.04), new THREE.MeshBasicMaterial({color: accent}))
      led.position.set(0, 0, 1.26)
      mesh.add(led)
      group.add(mesh)
      this.pickables.push(mesh)
      this.modules.set(service.id, {id: service.id, host: node.id, mesh, material: mat, kind})
      top = mesh.position.y + MODULE_H / 2
    })

    if (entry || critical) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(size * 0.72, size * 0.8, 64), new THREE.MeshBasicMaterial({color: critical ? COLORS.critical : COLORS.entry, transparent: true, opacity: 0.85, side: THREE.DoubleSide}))
      ring.rotation.x = -Math.PI / 2
      ring.position.y = 0.03
      group.add(ring)
    }
    if (critical) {
      const crown = new THREE.Mesh(new THREE.OctahedronGeometry(0.45), new THREE.MeshStandardMaterial({color: COLORS.critical, emissive: COLORS.critical, emissiveIntensity: 0.55, roughness: 0.3}))
      crown.position.y = top + 1.1
      crown.userData.spin = true
      group.add(crown)
    }

    const element = document.createElement('div')
    element.className = `twin-label${isHost ? '' : ' endpoint'}`
    const name = String(node.properties.hostname ?? node.id.split(':').slice(-2).join(':'))
    element.innerHTML = `<b></b>${entry ? '<i class="entry">Entry</i>' : ''}${critical ? '<i class="critical">Critical</i>' : ''}${housekeeping > 0 ? `<small>+${housekeeping} system</small>` : ''}`
    element.querySelector('b')!.textContent = name.length > 22 ? name.slice(0, 21) + '…' : name
    const label = new CSS2DObject(element)
    label.position.set(0, top + (critical ? 2.1 : 1.0), 0)
    group.add(label)
    this.world.add(group)
    this.hosts.set(node.id, {id: node.id, group, platform, material, top, label, base: position.clone(), entry, critical})
  }

  private anchor(id: string) {
    const host = this.hosts.get(id)!
    return host.base.clone().setY(host.top + 0.25)
  }

  private buildEdge(source: string, target: string, kind: string) {
    const a = this.anchor(source), b = this.anchor(target)
    const mid = a.clone().lerp(b, 0.5)
    mid.y += 1.4 + a.distanceTo(b) * 0.1
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b)
    const color = kind === 'INFERRED_REACHABILITY' ? COLORS.inferred : kind === 'CONFIRMED_ATTACK_TRANSITION' ? COLORS.confirmed : COLORS.observed
    let geometry: THREE.BufferGeometry
    if (kind === 'INFERRED_REACHABILITY') {
      // Dashed tube: inferred reachability is a model inference, not an observation.
      const pieces: THREE.BufferGeometry[] = []
      for (let i = 0; i < 18; i += 2) {
        const p0 = curve.getPoint(i / 18), p1 = curve.getPoint((i + 1) / 18)
        pieces.push(new THREE.TubeGeometry(new THREE.LineCurve3(p0, p1), 1, 0.06, 6, false))
      }
      geometry = mergeGeometries(pieces)
    } else {
      geometry = new THREE.TubeGeometry(curve, 48, 0.07, 8, false)
    }
    const material = new THREE.MeshBasicMaterial({color, transparent: true, opacity: kind === 'INFERRED_REACHABILITY' ? 0.75 : 0.8})
    const mesh = new THREE.Mesh(geometry, material)
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.6, 12), material)
    arrow.position.copy(curve.getPoint(0.86))
    arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), curve.getTangent(0.86).normalize())
    this.world.add(mesh, arrow)
    this.edges.push({source, target, kind, curve, mesh, material, arrow})
  }

  private buildParticles() {
    this.particleEdges = this.edges.flatMap(edge => [0, 0.33, 0.66].map(offset => ({edge, offset})))
    if (!this.particleEdges.length) return
    this.particles = new THREE.InstancedMesh(new THREE.SphereGeometry(0.13, 10, 10), new THREE.MeshBasicMaterial({color: 0x5eead4}), this.particleEdges.length)
    this.particles.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.particleEdges.forEach(({edge}, i) => this.particles!.setColorAt(i, new THREE.Color(edge.kind === 'INFERRED_REACHABILITY' ? 0xfbbf24 : 0x2dd4bf)))
    this.world.add(this.particles)
  }

  private buildZones(positions: Map<string, THREE.Vector3>, tiered: boolean) {
    if (!tiered || positions.size < 2) return
    const xs = [...positions.values()].map(p => p.x), zs = [...positions.values()].map(p => p.z)
    const minX = Math.min(...xs), maxX = Math.max(...xs), depth = Math.max(...zs) - Math.min(...zs) + 16, cz = (Math.max(...zs) + Math.min(...zs)) / 2
    const zones: [string, number, number][] = [['Perimeter', minX, 0x2563eb], ['Crown jewels', maxX, 0x7c3aed]]
    if (maxX - minX > 20) zones.splice(1, 0, ['Internal', (minX + maxX) / 2, 0x0d9488])
    for (const [name, x, color] of zones) {
      const band = new THREE.Mesh(new THREE.PlaneGeometry(11, depth), new THREE.MeshBasicMaterial({color, transparent: true, opacity: 0.045}))
      band.rotation.x = -Math.PI / 2
      band.position.set(x, 0.02, cz)
      const element = document.createElement('div')
      element.className = 'twin-zone'
      element.textContent = name
      const label = new CSS2DObject(element)
      label.position.set(x, 0.1, cz + depth / 2 + 1)
      this.world.add(band, label)
    }
  }

  private clearWorld() {
    this.stopAll()
    const disposeTree = (root: THREE.Object3D) => root.traverse(object => {
      if (object instanceof CSS2DObject) object.element.remove()
      const mesh = object as THREE.Mesh
      mesh.geometry?.dispose()
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined
      ;(Array.isArray(material) ? material : material ? [material] : []).forEach(m => m.dispose())
    })
    disposeTree(this.world)
    this.world.clear()
    this.hosts.clear()
    this.modules.clear()
    this.edges = []
    this.pickables = []
    this.particles = null
    this.particleEdges = []
  }

  // ---------------------------------------------------------------- interaction

  setSelected(id: string | null) {
    this.selected = id
    for (const m of this.modules.values()) {
      m.material.emissive.setHex(m.id === id ? 0x4f46e5 : 0x000000)
      m.material.emissiveIntensity = 0.35
    }
    const host = id ? this.hosts.get(id) ?? this.hosts.get(this.modules.get(id)?.host ?? '') : undefined
    this.selectionRing.visible = Boolean(host)
    if (host) this.selectionRing.position.set(host.base.x, 0.06, host.base.z)
  }

  focus(id: string) {
    const host = this.hosts.get(id) ?? this.hosts.get(this.modules.get(id)?.host ?? '')
    if (!host) return
    const target = host.base.clone().setY(1.5)
    const offset = this.camera.position.clone().sub(this.controls.target).setLength(30)
    this.animateCamera(target.clone().add(offset), target, 900)
  }

  resetCamera(animate = true) {
    const size = this.bounds.isEmpty() ? new THREE.Vector3(30, 4, 30) : this.bounds.getSize(new THREE.Vector3())
    const center = this.bounds.isEmpty() ? new THREE.Vector3() : this.bounds.getCenter(new THREE.Vector3())
    // Distance at which the footprint fits the frustum: width against the horizontal
    // half-angle, depth against the vertical one (foreshortened by the ~36° pitch).
    const half = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))
    const distance = Math.max(26, size.x / (2 * half * Math.max(this.camera.aspect, 0.5)), (size.z * 0.62) / (2 * half)) * 1.3
    const position = new THREE.Vector3(center.x + distance * 0.08, distance * 0.6, center.z + distance * 0.82)
    const target = center.clone().setY(1)
    if (animate) this.animateCamera(position, target, 900)
    else { this.camera.position.copy(position); this.controls.target.copy(target) }
  }

  setAutoRotate(on: boolean) { this.controls.autoRotate = on }

  private animateCamera(position: THREE.Vector3, target: THREE.Vector3, duration: number) {
    const fromP = this.camera.position.clone(), fromT = this.controls.target.clone()
    this.tween(duration, p => { const k = ease(p); this.camera.position.lerpVectors(fromP, position, k); this.controls.target.lerpVectors(fromT, target, k) })
  }

  private raycast(event: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const pointer = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
    const ray = new THREE.Raycaster()
    ray.setFromCamera(pointer, this.camera)
    return ray.intersectObjects(this.pickables, false)[0]?.object as THREE.Mesh | undefined
  }

  private handleDown = (event: PointerEvent) => { this.pointerDown.set(event.clientX, event.clientY) }
  private handleUp = (event: PointerEvent) => {
    if (this.pointerDown.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) > 5) return
    const hit = this.raycast(event)
    this.onSelect(hit ? String(hit.userData.id) : null)
  }
  private handleMove = (event: PointerEvent) => {
    const hit = this.raycast(event) ?? null
    if (hit === this.hovered) return
    if (this.hovered) this.hovered.scale.setScalar(1)
    this.hovered = hit
    if (hit) hit.scale.setScalar(1.05)
    this.renderer.domElement.style.cursor = hit ? 'pointer' : 'grab'
  }

  // ---------------------------------------------------------------- choreography helpers

  private tween(duration: number, update: (p: number) => void, done?: () => void, delay = 0) {
    this.tweens.push({start: this.clock.getElapsedTime() + delay / 1000 / this.speed, duration: duration / 1000 / this.speed, update, done})
  }

  private wait(ms: number) { return new Promise<void>(resolve => this.tween(ms, () => {}, resolve)) }
  private animate(ms: number, update: (p: number) => void) { return new Promise<void>(resolve => this.tween(ms, update, resolve)) }

  private ripple(position: THREE.Vector3, color: number, scale = 4, duration = 900, y = 0.08) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.05, 64), new THREE.MeshBasicMaterial({color, transparent: true, side: THREE.DoubleSide}))
    ring.rotation.x = -Math.PI / 2
    ring.position.copy(position).setY(y)
    this.overlay.add(ring)
    this.tween(duration, p => { ring.scale.setScalar(1 + p * scale); (ring.material as THREE.MeshBasicMaterial).opacity = 1 - p }, () => this.overlay.remove(ring))
  }

  private dimLive(active: Set<EdgeVisual>) {
    for (const e of this.edges) e.material.opacity = active.has(e) ? 0.95 : 0.1
    if (this.particles) this.particles.visible = false
  }

  /** Cancels any running choreography and restores the live twin. */
  stopAll() {
    this.generation++
    this.tweens = []
    this.overlay.clear()
    for (const e of this.edges) e.material.opacity = e.kind === 'INFERRED_REACHABILITY' ? 0.75 : 0.8
    for (const h of this.hosts.values()) { h.material.emissive.setHex(0); h.material.color.setHex(h.material.userData.base); h.label.element.classList.remove('breached', 'shielded', 'target') }
    for (const m of this.modules.values()) { m.mesh.visible = true; m.material.emissive.setHex(m.id === this.selected ? 0x4f46e5 : 0) }
    if (this.particles) this.particles.visible = true
  }

  // ---------------------------------------------------------------- attack replay

  /**
   * Replays a candidate route. Resolves 'reached' at the critical target or
   * 'blocked' when the comet meets the isolated (shielded) asset.
   */
  async playAttack(nodes: string[], isolated: string | null, onStep: (hop: number) => void): Promise<'reached' | 'blocked' | 'cancelled'> {
    this.stopAll()
    const generation = this.generation
    const live = () => generation === this.generation
    const route = nodes.filter(id => this.hosts.has(id))
    if (route.length < 2) return 'cancelled'
    const hops = route.slice(1).map((target, i) => this.edges.find(e => e.source === route[i] && e.target === target))
    this.dimLive(new Set(hops.filter(Boolean) as EdgeVisual[]))
    const shieldAt = isolated ? route.indexOf(isolated) : -1
    if (shieldAt > 0) this.raiseShield(route[shieldAt])

    const comet = new THREE.Mesh(new THREE.SphereGeometry(0.34, 20, 20), new THREE.MeshBasicMaterial({color: 0xff3b5c}))
    const halo = new THREE.Mesh(new THREE.SphereGeometry(0.75, 20, 20), new THREE.MeshBasicMaterial({color: 0xff3b5c, transparent: true, opacity: 0.25, depthWrite: false}))
    const light = new THREE.PointLight(0xff3b5c, 30, 12, 2)
    comet.add(halo, light)
    comet.position.copy(this.anchor(route[0]))
    this.overlay.add(comet)
    this.breach(route[0], true)
    onStep(0)
    await this.wait(500)

    for (let i = 0; i < hops.length; i++) {
      if (!live()) return 'cancelled'
      onStep(i + 1)
      const edge = hops[i]
      const curve = edge?.curve ?? new THREE.LineCurve3(this.anchor(route[i]), this.anchor(route[i + 1]))
      const trail = new THREE.Mesh(new THREE.TubeGeometry(curve as THREE.Curve<THREE.Vector3>, 64, 0.13, 8, false), new THREE.MeshBasicMaterial({color: COLORS.attack, transparent: true, opacity: 0.9}))
      const total = trail.geometry.index!.count
      trail.geometry.setDrawRange(0, 0)
      this.overlay.add(trail)
      const blocked = i + 1 === shieldAt
      const stop = blocked ? 0.82 : 1
      await this.animate(1150, p => {
        const k = ease(p) * stop
        comet.position.copy(curve.getPoint(k))
        trail.geometry.setDrawRange(0, Math.floor((k * total) / 6) * 6)
        if (Math.random() < 0.5) this.spark(comet.position)
      })
      if (!live()) return 'cancelled'
      if (blocked) {
        this.ripple(this.hosts.get(route[i + 1])!.base, COLORS.shield, 5)
        this.burst(comet.position, COLORS.shield)
        this.overlay.remove(comet)
        this.hosts.get(route[i + 1])!.label.element.classList.add('shielded')
        return 'blocked'
      }
      this.breach(route[i + 1], i + 1 === route.length - 1)
      await this.wait(260)
    }
    if (!live()) return 'cancelled'
    this.alarm(route[route.length - 1])
    return 'reached'
  }

  private breach(id: string, target: boolean) {
    const host = this.hosts.get(id)!
    host.label.element.classList.add(target && host.critical ? 'target' : 'breached')
    this.ripple(host.base, COLORS.attack, 3.5)
    const from = new THREE.Color(host.material.userData.base), to = new THREE.Color(0xffe4e8)
    this.tween(500, p => { host.material.color.copy(from).lerp(to, easeOut(p)); host.material.emissive.setHex(COLORS.attack); host.material.emissiveIntensity = 0.35 * (1 - p) + 0.08 })
    for (const m of this.modules.values()) if (m.host === id) m.material.emissive.setHex(0x9f1239)
  }

  private alarm(id: string) {
    const host = this.hosts.get(id)!
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.6, 26, 32, 1, true),
      new THREE.MeshBasicMaterial({color: COLORS.attack, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending}))
    beam.position.copy(host.base).setY(13)
    this.overlay.add(beam)
    const generation = this.generation
    const pulse = () => {
      if (generation !== this.generation) return
      this.ripple(host.base, COLORS.attack, 6, 1400)
      this.tween(1400, p => { (beam.material as THREE.MeshBasicMaterial).opacity = 0.16 + Math.sin(p * Math.PI) * 0.14 }, pulse)
    }
    pulse()
  }

  private raiseShield(id: string) {
    const host = this.hosts.get(id)!
    const dome = new THREE.Mesh(new THREE.SphereGeometry(3.4, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshPhysicalMaterial({color: COLORS.shield, transparent: true, opacity: 0, roughness: 0.1, clearcoat: 1, side: THREE.DoubleSide, depthWrite: false}))
    const wire = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(3.42, 2)), new THREE.LineBasicMaterial({color: COLORS.shield, transparent: true, opacity: 0}))
    dome.position.copy(host.base)
    wire.position.copy(host.base)
    this.overlay.add(dome, wire)
    this.tween(700, p => { (dome.material as THREE.MeshPhysicalMaterial).opacity = 0.22 * p; (wire.material as THREE.LineBasicMaterial).opacity = 0.18 * p; dome.scale.setScalar(0.6 + 0.4 * easeOut(p)) })
    host.label.element.classList.add('shielded')
  }

  private spark(position: THREE.Vector3) {
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.09, 6, 6), new THREE.MeshBasicMaterial({color: 0xff6b81, transparent: true}))
    dot.position.copy(position).add(new THREE.Vector3((Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4))
    this.overlay.add(dot)
    this.tween(600, p => { (dot.material as THREE.MeshBasicMaterial).opacity = 1 - p; dot.scale.setScalar(1 - p * 0.7); dot.position.y -= 0.004 }, () => this.overlay.remove(dot))
  }

  private burst(position: THREE.Vector3, color: number) {
    for (let i = 0; i < 18; i++) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.1, 6, 6), new THREE.MeshBasicMaterial({color, transparent: true}))
      const direction = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).normalize()
      dot.position.copy(position)
      this.overlay.add(dot)
      this.tween(700, p => { dot.position.copy(position).addScaledVector(direction, easeOut(p) * 2.6); (dot.material as THREE.MeshBasicMaterial).opacity = 1 - p }, () => this.overlay.remove(dot))
    }
  }

  // ---------------------------------------------------------------- emulation replay

  /** Replays an emulation run: clone → isolate → probe → verdict → teardown, wave by wave. */
  async playSimulation(waves: SimulationWave[], onPhase: (wave: number, phase: 'cloning' | 'probing' | 'verdicts' | 'cleanup' | 'done') => void) {
    this.stopAll()
    const generation = this.generation
    const live = () => generation === this.generation
    const center = this.bounds.isEmpty() ? new THREE.Vector3() : this.bounds.getCenter(new THREE.Vector3())
    const widest = Math.max(1, ...waves.map(w => w.services.length))
    const width = Math.max(10, widest * 3.6 + 3)
    const box = new THREE.Group()
    box.position.set(center.x, 15, center.z - 4)
    const glass = new THREE.Mesh(new THREE.BoxGeometry(width, 6, 8), new THREE.MeshPhysicalMaterial({color: 0xe0e7ff, transparent: true, opacity: 0.18, roughness: 0.05, clearcoat: 1, depthWrite: false}))
    const frame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(width, 6, 8)), new THREE.LineBasicMaterial({color: COLORS.sandbox}))
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(width, 8), new THREE.MeshBasicMaterial({color: COLORS.sandbox, transparent: true, opacity: 0.08, side: THREE.DoubleSide}))
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -2.98
    const element = document.createElement('div')
    element.className = 'twin-sandbox'
    element.innerHTML = '<b>Isolated sandbox</b><span>tenant-scoped · internal network · no egress</span>'
    const tag = new CSS2DObject(element)
    tag.position.set(0, 3.9, 0)
    box.add(glass, frame, floor, tag)
    box.scale.setScalar(0.01)
    this.overlay.add(box)
    await this.animate(700, p => box.scale.setScalar(0.01 + 0.99 * easeOut(p)))

    for (const wave of waves) {
      if (!live()) return
      onPhase(wave.index, 'cloning')
      const targets = wave.services.filter(s => this.modules.has(s.id))
      const clones = targets.map((service, i) => {
        const source = this.modules.get(service.id)!
        const from = source.mesh.getWorldPosition(new THREE.Vector3())
        const slot = box.position.clone().add(new THREE.Vector3((i - (targets.length - 1) / 2) * 3.6, -2.2, 0))
        const material = new THREE.MeshStandardMaterial({color: 0xeef2ff, emissive: COLORS.sandbox, emissiveIntensity: 0.25, transparent: true, opacity: 0.95})
        const clone = new THREE.Mesh(new RoundedBoxGeometry(2.4, MODULE_H * 1.6, 2.4, 3, 0.14), material)
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(2.4, MODULE_H * 1.6, 2.4)), new THREE.LineBasicMaterial({color: COLORS.sandbox}))
        clone.add(edges)
        clone.position.copy(from)
        this.overlay.add(clone)
        const lift = from.clone().lerp(slot, 0.5).setY(Math.max(from.y, slot.y) + 4)
        const path = new THREE.QuadraticBezierCurve3(from, lift, slot)
        const beam = new THREE.Mesh(new THREE.TubeGeometry(path, 40, 0.035, 6, false), new THREE.MeshBasicMaterial({color: COLORS.sandbox, transparent: true, opacity: 0.5}))
        this.overlay.add(beam)
        source.material.emissive.setHex(COLORS.sandbox)
        this.tween(1100, p => clone.position.copy(path.getPoint(ease(p))), undefined, i * 160)
        this.tween(1600, p => { (beam.material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - p) }, () => this.overlay.remove(beam), 900 + i * 160)
        return {service, clone, material, source, slot}
      })
      await this.wait(1250 + targets.length * 160)
      if (!live()) return

      onPhase(wave.index, 'probing')
      const probe = new THREE.Mesh(new THREE.IcosahedronGeometry(0.38, 1), new THREE.MeshStandardMaterial({color: 0x4f46e5, emissive: 0x4f46e5, emissiveIntensity: 0.6}))
      probe.position.copy(box.position).add(new THREE.Vector3(0, 0.6, 2.5))
      this.overlay.add(probe)
      const rays = clones.map(c => {
        const ray = new THREE.Mesh(new THREE.TubeGeometry(new THREE.LineCurve3(probe.position.clone(), c.slot.clone().setY(c.slot.y + 0.4)), 1, 0.04, 6, false),
          new THREE.MeshBasicMaterial({color: 0x818cf8, transparent: true, opacity: 0}))
        this.overlay.add(ray)
        return ray
      })
      await this.animate(1800, p => {
        probe.rotation.y = p * 8
        probe.position.x = box.position.x + Math.sin(p * Math.PI * 2) * (width / 2 - 1.5)
        rays.forEach((ray, i) => { (ray.material as THREE.MeshBasicMaterial).opacity = Math.max(0, Math.sin((p * 3 + i * 0.3) * Math.PI)) * 0.7 })
        clones.forEach((c, i) => { c.material.emissiveIntensity = 0.25 + Math.max(0, Math.sin((p * 4 + i * 0.5) * Math.PI)) * 0.4 })
      })
      rays.forEach(r => this.overlay.remove(r))
      this.overlay.remove(probe)
      if (!live()) return

      onPhase(wave.index, 'verdicts')
      clones.forEach(({service, clone, material}, i) => {
        const color = service.verdict ? VERDICT_COLORS[service.verdict] : 0x94a3b8
        this.tween(450, p => { material.color.set(0xffffff).lerp(new THREE.Color(color), p * 0.55); material.emissive.setHex(color); material.emissiveIntensity = 0.45; clone.scale.setScalar(1 + Math.sin(p * Math.PI) * 0.18) }, undefined, i * 140)
        this.tween(10, () => {}, () => this.ripple(clone.position, color, 1.4, 700, box.position.y - 2.9), i * 140)
      })
      await this.wait(1300 + clones.length * 140)
      if (!live()) return

      onPhase(wave.index, 'cleanup')
      await this.animate(700, p => clones.forEach(({clone, material}) => { clone.scale.setScalar(1 - easeOut(p) * 0.9); material.opacity = 0.95 * (1 - p) }))
      clones.forEach(c => { this.overlay.remove(c.clone); c.source.material.emissive.setHex(0) })
      await this.wait(250)
    }
    if (!live()) return
    onPhase(waves.length ? waves[waves.length - 1].index : 0, 'done')
    await this.animate(600, p => box.scale.setScalar(1 - easeOut(p) * 0.99))
    if (live()) this.overlay.remove(box)
  }

  // ---------------------------------------------------------------- frame loop

  private loop = () => {
    this.frame = requestAnimationFrame(this.loop)
    const now = this.clock.getElapsedTime()
    const active = this.tweens
    this.tweens = []
    for (const t of active) {
      if (now < t.start) { this.tweens.push(t); continue }
      const p = Math.min(1, (now - t.start) / Math.max(t.duration, 1e-6))
      t.update(p)
      if (p < 1) this.tweens.push(t)
      else t.done?.()
    }
    if (this.particles) {
      const m = new THREE.Matrix4()
      this.particleEdges.forEach(({edge, offset}, i) => {
        const k = (now * 0.22 * (edge.kind === 'INFERRED_REACHABILITY' ? 0.6 : 1) + offset) % 1
        m.makeTranslation(edge.curve.getPoint(k))
        this.particles!.setMatrixAt(i, m)
      })
      this.particles.instanceMatrix.needsUpdate = true
    }
    this.world.traverse(object => { if (object.userData.spin) { object.rotation.y = now * 1.2; object.position.y += Math.sin(now * 2) * 0.004 } })
    if (this.selectionRing.visible) {
      const s = 1 + Math.sin(now * 3) * 0.05
      this.selectionRing.scale.set(s, s, s)
    }
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
    this.labels.render(this.scene, this.camera)
  }

  private resize() {
    const {clientWidth: w, clientHeight: h} = this.container
    if (!w || !h) return
    this.renderer.setSize(w, h)
    this.labels.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  dispose() {
    cancelAnimationFrame(this.frame)
    this.observer.disconnect()
    this.clearWorld()
    this.controls.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
    this.labels.domElement.remove()
  }
}
