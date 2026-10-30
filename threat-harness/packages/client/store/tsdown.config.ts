import { staticLinked } from '../tsdown.client.ts'

export default staticLinked(
  '@elemental/client-store',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
