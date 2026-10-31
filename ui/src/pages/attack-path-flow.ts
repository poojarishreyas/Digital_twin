// Timing is internal to the demo; the UI only shows the current activity.
export const SCAN_DURATION_MS = 180_000
export const SCAN_STAGE_COUNT = 4

export function scanState(startedAt: number, now: number) {
  const elapsed = Math.max(0, now - startedAt)
  return {
    step: Math.min(SCAN_STAGE_COUNT - 1, Math.floor(elapsed / (SCAN_DURATION_MS / SCAN_STAGE_COUNT))),
    complete: elapsed >= SCAN_DURATION_MS,
  }
}
