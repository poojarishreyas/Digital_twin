import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@elemental/api-workspace-controller',
  ['lib/types/index.js', 'lib/types/invariant.js'],
  { hostPhase: true },
)
