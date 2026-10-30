import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@elemental/api-session-controller',
  ['lib/types/index.js', 'lib/types/invariant.js'],
  { hostPhase: true },
)
