import type { InvocationDeadlines } from "../harness/invoke.ts"

export const REVIEW_INVOCATION_DEADLINES = {
  overallMillis: 600_000,
  startupMillis: 60_000,
  firstResponseMillis: 300_000,
  toolMillis: 120_000,
  bashMillis: 600_000,
} as const satisfies InvocationDeadlines
