// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { DocumentTitle } from '../src/client/DocumentTitle.tsx'

afterEach(() => {
  cleanup()
  document.title = ''
  vi.unstubAllEnvs()
})

describe('DocumentTitle', () => {
  it('projects a durable title and restores the product title', () => {
    vi.stubEnv('ELEMENTAL_CLIENT_TITLE', 'Elemental Harness')
    document.title = 'stale title'
    const mounted = render(<DocumentTitle productTitle="Elemental Harness" />)
    expect(document.title).toBe('Elemental Harness')
    mounted.rerender(<DocumentTitle title="First title" productTitle="Elemental Harness" />)
    expect(document.title).toBe('First title — Elemental Harness')
    mounted.rerender(<DocumentTitle title="Revised title" productTitle="Elemental Harness" />)
    expect(document.title).toBe('Revised title — Elemental Harness')
    mounted.rerender(<DocumentTitle productTitle="Elemental Harness" />)
    expect(document.title).toBe('Elemental Harness')
    mounted.unmount()
    expect(document.title).toBe('Elemental Harness')
  })

  it('uses the generic title when the build provides no title', () => {
    vi.stubEnv('ELEMENTAL_CLIENT_TITLE', '')
    delete process.env.ELEMENTAL_CLIENT_TITLE
    const mounted = render(<DocumentTitle title="First title" productTitle="Elemental Local Build" />)
    expect(document.title).toBe('First title — Elemental Local Build')
    mounted.unmount()
    expect(document.title).toBe('Elemental Local Build')
  })
})
