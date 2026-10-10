// What the strip shows of each invocation (#181): a thin wrapper over the
// Claude Code Host's HarnessSessionFactory that watches each session's life,
// from its open to its dispose, and the item count of its accepted emit.
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { HarnessSessionFactoryContract } from "../src/harness/harness-session.ts"

// One invocation as the strip draws it, kept after its session is disposed,
// for the run's life.
export interface AgentActivity {
  readonly id: string
  readonly invocationId: string
  state: "opening" | "running" | "answered" | "failed" | "stopped"
  // The accepted emit's item count (findings, clusters, verdicts, decisions).
  items?: number
}

// An accepted emit's items, under its contract's one list field.
const EmitItems = Schema.Struct({
  findings: Schema.optional(Schema.Array(Schema.Unknown)),
  clusters: Schema.optional(Schema.Array(Schema.Unknown)),
  verdicts: Schema.optional(Schema.Array(Schema.Unknown)),
  decisions: Schema.optional(Schema.Array(Schema.Unknown)),
})

const itemCount = (args: Schema.Json) =>
  Option.getOrUndefined(
    Option.map(
      Schema.decodeUnknownOption(EmitItems)(args),
      (items) => (items.findings ?? items.clusters ?? items.verdicts ?? items.decisions)?.length,
    ),
  )

// One run's activity, and the factory wrapper that records it. A session that
// ends without an accepted emit failed, unless the run stopped it.
export const makeActivity = () => {
  const activity: Array<AgentActivity> = []
  const watch = (factory: HarnessSessionFactoryContract): HarnessSessionFactoryContract => ({
    ...factory,
    open: (config) => {
      const record: AgentActivity = { id: `${config.invocationId}#${String(activity.length + 1)}`, invocationId: config.invocationId, state: "opening" }
      activity.push(record)
      let stopped = false
      const execute = (args: Schema.Json) => {
        record.state = "answered"
        const items = itemCount(args)
        if (items !== undefined) record.items = items
        config.emitTool.execute(args)
      }
      return factory.open({ ...config, emitTool: { ...config.emitTool, execute } }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            record.state = "failed"
          })
        ),
        Effect.map((session) => ({
          ...session,
          prompt: (text: string) => {
            if (record.state === "opening") record.state = "running"
            return session.prompt(text)
          },
          abort: () => {
            stopped = true
            return session.abort()
          },
          dispose: () => {
            if (record.state !== "answered") record.state = stopped ? "stopped" : "failed"
            session.dispose()
          },
        })),
      )
    },
  })
  return {
    watch,
    // This run's invocations in open order, copied for the strip.
    activity: (): ReadonlyArray<AgentActivity> => activity.map((each) => ({ ...each })),
  }
}
