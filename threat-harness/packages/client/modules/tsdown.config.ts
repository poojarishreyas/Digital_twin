import { clientBundle } from '../tsdown.client.ts'

export default clientBundle(
  '@elemental/client-modules',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
