import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as References from "effect/References"
import * as Command from "effect/cli/Command"
import { displayServerStdio } from "../mcp/dossier-display.ts"

// stdout carries only the MCP protocol, so logs go to stderr. The stdio
// transport interrupts the server's fiber when the client closes stdin, which
// is how the server ends: a clean exit, not an interrupted one.
export const mcpCommand = Command.make(
  "mcp",
  {},
  () =>
    Layer.launch(displayServerStdio).pipe(
      // Its one failure is a protocol list the runtime rejects: a defect.
      Effect.orDie,
      Effect.forkChild,
      Effect.flatMap(Fiber.await),
      Effect.flatMap((exit) => Exit.hasInterrupts(exit) ? Effect.void : exit),
      Effect.provideService(References.LogToStderr, true),
    ),
).pipe(
  Command.withDescription(
    "Serve a display-only MCP server on stdio: show_dossier shows a finished Run's Dossier as an MCP App",
  ),
)
