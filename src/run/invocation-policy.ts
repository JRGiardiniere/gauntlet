// One overall deadline per AgentInvocation, corrective turns included.
export const REVIEW_INVOCATION_DEADLINE_MILLIS = 600_000

// How long Finder followers wait for the starter's first token before
// starting anyway, so a stalled starter cannot hold its partition until the
// overall deadline.
export const FINDER_FOLLOWER_WAIT_MILLIS = 120_000
