import { staticLinked } from '../tsdown.client.ts'

export default staticLinked(
  '@elemental/client-web',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
