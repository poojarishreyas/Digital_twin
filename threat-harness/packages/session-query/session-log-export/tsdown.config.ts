import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@elemental/session-log-export',
  ['lib/types/index.js', 'lib/types/invariant.js'],
  { hostPhase: true },
)
