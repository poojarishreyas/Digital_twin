/** Wire types for lossless incremental deepseek session-log upload. */

import type { SessionEvent, SessionHeader } from '@elemental/session'

/** Versioned incremental session-log field carried by an official deepseek request. */
export interface deepseekSessionLogExtension {
  readonly version: 1
  readonly session: SessionHeader
  /** Highest sequence durably recorded as accepted before this request, or `-1`. */
  readonly afterSeq: number
  /** Highest sequence represented by {@link events}. */
  readonly throughSeq: number
  /** Complete canonical event envelopes for every sequence from `afterSeq + 1` through `throughSeq`. */
  readonly events: readonly SessionEvent[]
}

declare module '@elemental/deepseek-llm-api-extensions/types' {
  interface deepseekLlmApiExtensionMap {
    dsh_session_log: deepseekSessionLogExtension
  }
}

declare module '@elemental/session/types' {
  interface SessionEventMap {
    /** Records that the configured endpoint accepted one delivery through `throughSeq`. */
    'session-log-deepseek/delivery-accepted': {
      /** Session identity the accepted delivery carried; inherited fork markers retain the parent's id. */
      sessionId: import('@elemental/session/types').SessionId
      /** Last canonical event included in the accepted request. */
      throughSeq: number
    }
  }
}
