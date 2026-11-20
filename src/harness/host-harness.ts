import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Host } from "../host/host.ts"
import { HarnessSessionFactory, InvocationSetupError } from "./harness-session.ts"

// The live harness: every AgentInvocation is a session on the embedded Host.
export const hostHarnessLayer = Layer.effect(
  HarnessSessionFactory,
  Effect.gen(function* () {
    const host = yield* Host

    return HarnessSessionFactory.of({
      open: (spec) =>
        host.openSession(spec).pipe(
          Effect.mapError((error) =>
            InvocationSetupError.make({ reason: `${error.operation}: ${error.reason}`, cause: error })),
        ),
    })
  }),
)
