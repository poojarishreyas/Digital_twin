const assert = require('node:assert/strict')
const {readFileSync} = require('node:fs')
const path = require('node:path')
const {test} = require('node:test')
const ts = require('typescript')
const React = require('react')
const {act, create} = require('react-test-renderer')

// Exercise the real component and effects while substituting the WebGL view
// and clock. No browser, server, production credentials or real wait required.
function load(filename, overrides = {}) {
  const code = ts.transpileModule(readFileSync(path.join(__dirname, '..', filename), 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022},
  }).outputText
  const module = {exports: {}}
  new Function('require', 'module', 'exports', code)(id => id in overrides ? overrides[id] : require(id), module, module.exports)
  return module.exports
}

const flow = load('src/pages/attack-path-flow.ts')
const reports = load('src/pages/attack-path-report.ts')
const reportUI = load('src/pages/AttackPathAnalysis.tsx', {
  './attack-path-report': reports, '../ui/icons': {Icon: () => null},
})

test('research-backed report selects the shop scenario and keeps unknown workspaces unverified', () => {
  const route = {id: 'path-1', nodes: ['web', 'app', 'db'], hop_count: 2, issues: [], steps: [
    {source: 'web', target: 'app', kind: 'OBSERVED_CONNECTION', observed_at: '2026-10-31T01:00:00Z', evidence_source: 'socket.established', freshness: 'fresh'},
  ]}
  const topology = {nodes: route.nodes.map((id, index) => ({id, properties: {hostname: ['shop-web01', 'shop-app01', 'shop-db01'][index]}})), edges: []}
  const analysis = reports.analyzeFinding(route, topology)
  assert.match(analysis.title, /Unauthenticated order-history API/)
  assert.equal(analysis.severity, 'High')
  assert.equal(analysis.controlAssetId, 'app')
  assert.match(analysis.classification, /CWE-306/)
  assert.ok(analysis.references.some(value => value.url.startsWith('https://redis.io/')))
  assert.match(analysis.basis, /live exploitability unverified/i)
  const generic = reports.analyzeFinding(route, {nodes: [], edges: []})
  assert.equal(generic.severity, 'Needs validation')
  assert.doesNotMatch(generic.title, /Redis|order-history/)
  const scan = {id: 'TH-TEST', capturedAt: '2026-10-31T01:00:00Z', routes: [route], topology, total: 1, truncated: false}
  const markdown = reports.reportMarkdown(scan, [])
  assert.match(markdown, /Executive analysis/)
  assert.match(markdown, /Verification plan \(not executed\)/)
  assert.match(markdown, /socket\.established/)
  assert.match(markdown, /NOT_RECORDED/)
  assert.match(markdown, /No CVE is assigned/)
  const fixed = reports.reportData(scan, ['path-1'])
  assert.equal(fixed.summary.unresolvedFindings, 0)
  assert.equal(fixed.findings[0].status, 'Remediated in simulation')
  assert.deepEqual(fixed.execution, {llmCalled: false, liveProbesExecuted: false, liveChangesApplied: false})
  assert.match(reports.reportMarkdown({...scan, routes: []}, ['path-1']), /No attack path found/)
  const confirmed = {...route, validation_status: 'partially_confirmed', confirmed_hops: 1,
    steps: [{...route.steps[0], confirmed: true, confirmation: {evidence_source: 'sandbox:run-1', basis: ['confirmed_chain_scenario'], run_id: 'run-1', test_ids: ['scenario.http_chain'], observed_at: '2026-10-31T01:00:00Z'}}],
    remediation: {service: 'fixture', change: 'require authentication', retest: 'anonymous denied', workflows: 'customer access preserved'}}
  const mergedReport = reports.reportData({...scan, routes: [confirmed]}, [])
  assert.equal(mergedReport.findings[0].hops[0].confirmation.run_id, 'run-1')
  assert.equal(mergedReport.findings[0].confirmedHops, 1)
  assert.match(reports.reportMarkdown({...scan, routes: [confirmed]}, []), /Sandbox repair evidence/)
})

test('scan remains private until three minutes and catches up after a suspended tab', () => {
  const started = 123456
  assert.equal(flow.SCAN_DURATION_MS, 180000)
  for (const [elapsed, step, complete] of [
    [0, 0, false], [44999, 0, false], [45000, 1, false],
    [90000, 2, false], [135000, 3, false], [179999, 3, false],
    [180000, 3, true], [400000, 3, true], [-1000, 0, false],
  ]) assert.deepEqual(flow.scanState(started, started + elapsed), {step, complete})
})

test('codebase gate → scan → real PR stays pending → merged source yields clean rescan', async () => {
  let now = 1000000, nextId = 0
  const timers = new Map(), listeners = new Map(), replayCalls = []
  let exportedBlob, downloadedName
  const previous = {window: global.window, document: global.document, now: Date.now, createURL: URL.createObjectURL, revokeURL: URL.revokeObjectURL}
  URL.createObjectURL = blob => { exportedBlob = blob; return 'blob:report-preview' }
  URL.revokeObjectURL = () => {}
  global.window = {
    setInterval(callback, delay) { const id = ++nextId; timers.set(id, {callback, due: now + delay, delay}); return id },
    clearInterval(id) { timers.delete(id) },
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, {callback, due: now + delay}); return id },
    clearTimeout(id) { timers.delete(id) },
  }
  global.document = {
    createElement() { return {click() { downloadedName = this.download }} },
    addEventListener(name, fn) { listeners.set(name, fn) },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name) },
  }
  Date.now = () => now
  const route = {id: 'path-1', nodes: ['web', 'app', 'db'], hop_count: 2, steps: [], review_order: 1, issues: [], next_action: ''}
  const originalSource = {url: 'https://github.com/example/lab', slug: 'example/lab', branch: 'main', commit: 'a'.repeat(40), vulnerable: true, status: 'vulnerable', file: 'app.py', scenario: 'order-history-auth'}
  let serverConnection = {codebase: originalSource, pr_enabled: true}, connected = false, repairCalls = 0
  const topology = {nodes: route.nodes.map((id, index) => ({id, labels: ['Host'], properties: {hostname: ['shop-web01', 'shop-app01', 'shop-db01'][index]}})), edges: []}
  const twinHandle = {
    async playAttack(nodes, isolated, onStep) {
      replayCalls.push({nodes, isolated})
      nodes.forEach((_, hop) => onStep(hop))
      return isolated ? 'blocked' : 'reached'
    },
    stop() {},
  }
  const Twin3D = React.forwardRef((props, ref) => {
    React.useImperativeHandle(ref, () => twinHandle, [])
    return React.createElement('twin', null, props.children)
  })
  const {AttackPaths} = load('src/pages/AttackPaths.tsx', {
    '../api': {api: {get: async () => ({assessments: [route], universe: {entries: ['web'], critical: ['db'], path_count: 1}}), post: async (url, body) => {
      assert.equal(url, '/api/codebase/repair'); assert.equal(body.commit, originalSource.commit); repairCalls++
      serverConnection = {...serverConnection, codebase: {...originalSource, pr: {url: 'https://github.com/example/lab/pull/1', number: 1, base_commit: originalSource.commit}}}
      return serverConnection
    }}, message: String},
    '../auth': {useSession: () => ({principal: {role: 'admin'}})},
    '../codebase': {useCodebase: () => {
      const [connection, setConnection] = React.useState(connected ? serverConnection : {codebase: null, pr_enabled: false})
      return {connection, setConnection, loading: false, error: '', refresh: async () => { setConnection(serverConnection); return serverConnection }}
    }},
    '../twin/Twin3D': {Twin3D},
    '../ui/icons': {Icon: () => null},
    '../ui/Modal': {Modal: props => React.createElement('dialog', null, props.children)},
    '../useTwinData': {hostName: (_, id) => id},
    './attack-path-flow': flow,
    './AttackPathAnalysis': reportUI,
  })
  let renderer
  const label = node => typeof node === 'string' ? node : (node.children ?? []).map(label).join('')
  const button = text => renderer.root.findAllByType('button').find(node => label(node) === text)
  const text = () => label(renderer.root)
  async function advance(ms) {
    await act(async () => {
      now += ms
      for (const [id, timer] of [...timers]) if (now >= timer.due) {
        if (timer.delay) timer.due = now + timer.delay
        else timers.delete(id)
        timer.callback()
      }
    })
  }
  try {
    const props = {data: {topology, updated: 1}, selected: null, onSelect() {}, go() {}}
    await act(async () => { renderer = create(React.createElement(AttackPaths, props)) })
    assert.match(text(), /Add your GitHub codebase first/)
    assert.equal(button('Analyze code and paths'), undefined)
    assert.equal(renderer.root.findAllByType('dialog').length, 0)
    await act(async () => renderer.unmount())
    connected = true
    await act(async () => { renderer = create(React.createElement(AttackPaths, props)) })
    assert.equal(renderer.root.findAllByType('dialog').length, 1)
    await act(async () => button('Analyze code and paths').props.onClick())
    assert.match(text(), /Reading the digital twin/)
    assert.doesNotMatch(text(), /\b180\b|\b3:00\b|countdown|remaining|1\/4/i)
    assert.equal(button('Fix now'), undefined)
    await advance(179999)
    assert.equal(replayCalls.length, 0)
    assert.equal(button('Fix now'), undefined)
    await advance(1)
    assert.equal(renderer.root.findAllByType('dialog').length, 0)
    assert.deepEqual(replayCalls, [{nodes: route.nodes, isolated: null}])
    assert.match(text(), /Critical asset reached/)
    assert.match(text(), /Unauthenticated order-history API/)
    assert.match(text(), /View detailed analysis report/)
    assert.match(text(), /Root cause/)
    assert.match(text(), /Live validation pending/)
    await act(async () => button('Download report').props.onClick())
    assert.match(downloadedName, /-analysis\.md$/)
    assert.match(await exportedBlob.text(), /Unauthenticated order-history API/)
    await act(async () => button('JSON').props.onClick())
    assert.equal(JSON.parse(await exportedBlob.text()).execution.liveProbesExecuted, false)
    await act(async () => button('Fix now').props.onClick())
    assert.equal(renderer.root.findAllByType('dialog').length, 1)
    assert.equal(repairCalls, 1)
    assert.match(text(), /Review repair PR #1/)
    assert.match(text(), /pending review/)
    assert.doesNotMatch(text(), /Simulated fix applied/)
    assert.ok(button('Fix now').props.disabled)
    // An open PR is not a fixed default branch: the next scan still finds it.
    await act(async () => button('Run again').props.onClick())
    await advance(180000)
    assert.match(text(), /Unauthenticated order-history API/)
    assert.doesNotMatch(text(), /No attack path found/)
    serverConnection = {codebase: {...originalSource, vulnerable: false, status: 'fixed', commit: 'b'.repeat(40)}, pr_enabled: true}
    await act(async () => button('View findings').props.onClick())
    await act(async () => button('Run again').props.onClick())
    const replaysBeforeRescan = replayCalls.length
    assert.doesNotMatch(text(), /No attack path found/)
    await advance(179999)
    assert.equal(replayCalls.length, replaysBeforeRescan)
    assert.doesNotMatch(text(), /No attack path found/)
    await advance(1)
    assert.match(text(), /No attack path found/)
    assert.match(text(), /Repository repair verified/)
    await act(async () => button('Download report').props.onClick())
    assert.match(await exportedBlob.text(), /No attack path found/)
    assert.equal(button('Fix now'), undefined)
    assert.equal(button('Replay attack path'), undefined)
    assert.equal(replayCalls.length, replaysBeforeRescan)
    // A further run keeps the fix too, and starts the full delay again.
    await act(async () => button('Run again').props.onClick())
    assert.doesNotMatch(text(), /No attack path found/)
    await advance(180000)
    assert.match(text(), /No attack path found/)
    assert.equal(replayCalls.length, replaysBeforeRescan)
    await act(async () => renderer.unmount())
    assert.equal(timers.size, 0)
    assert.equal(listeners.size, 0)
  } finally {
    if (renderer) await act(async () => renderer.unmount())
    global.window = previous.window; global.document = previous.document; Date.now = previous.now
    URL.createObjectURL = previous.createURL; URL.revokeObjectURL = previous.revokeURL
  }
})
