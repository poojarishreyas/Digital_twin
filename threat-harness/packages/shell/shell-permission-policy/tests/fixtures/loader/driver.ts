#!/usr/bin/env node
/**
 * Test driver: boot the shell-permission Loader composition, run a read-only, a
 * denied, and an unapproved command through the platform shell tool, and persist
 * the model-visible results to `./permission-loader-report.json` for the spec.
 */

import { writeFile } from 'node:fs/promises'
import { boot, resolveConfigPath } from '@elemental/app-boot'
import { ToolCallId } from '@elemental/llm'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('shell-permission driver requires a config path')

const ctx = await boot('shell-permission-loader-smoke', resolveConfigPath(configPath, undefined))
try {
  const tool = process.platform === 'win32' ? 'pwsh' : 'bash'
  const run = async (id: string, command: string): Promise<{ isError: boolean; text: string }> => {
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(id),
      name: tool,
      arguments: { command, description: id },
    })
    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
    return { isError: result.isError, text: text.replace(/\r\n/g, '\n') }
  }
  await writeFile('./permission-loader-report.json', JSON.stringify({
    readOnly: await run('read-only', 'echo permission-ok'),
    denied: await run('denied', 'git push origin main'),
    unapproved: await run('unapproved', 'npm run build'),
  }))
} finally {
  await ctx.fiber.dispose()
}
