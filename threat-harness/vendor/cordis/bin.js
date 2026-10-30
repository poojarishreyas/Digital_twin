#!/usr/bin/env node

import { Context } from '@elemental/cordis'
import { pathToFileURL } from 'node:url'
import Loader from '@elemental/cordis-plugin-loader'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@elemental/cordis-plugin-include',
  config: {
    path: './cordis.yml',
  },
})
