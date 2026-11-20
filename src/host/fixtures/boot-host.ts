// Boots a Host under whatever HOME the test gives this process and prints
// what it loaded as JSON. `gauntlet` boots Gauntlet's Host; `control` boots
// OpenCode with its defaults, to show the same fake home leaks without
// Gauntlet's isolation. Run by host.test.ts as a subprocess, because
// OpenCode's default paths come from the process's own home directory.
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { Integration } from "@opencode/core/integration"
import { OpenCode } from "@opencode/sdk/effect"
import * as Array from "effect/Array"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { hostPaths } from "../host.ts"
import { bootHost } from "../opencode-host.ts"

const [mode = "gauntlet", catalogPath = ""] = process.argv.slice(2)

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

const client = Effect.gen(function* () {
  if (mode === "gauntlet") {
    const paths = yield* hostPaths()
    const host = yield* bootHost(paths, { _tag: "File", path: catalogPath })

    return { client: host.client, location: host.location }
  }

  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* Config.String("HOME")
  const location = { directory: path.join(home, "control-location") }
  yield* fs.makeDirectory(location.directory, { recursive: true })

  const opencode = yield* OpenCode.create({
    database: { path: path.join(home, "control.db") },
    models: { file: catalogPath, fetch: false, snapshot: false },
    fs: { filewatcher: false, fff: false },
  })

  return { client: opencode, location }
})

const program = Effect.gen(function* () {
  const { client: opencode, location } = yield* client

  // A cold Location's first answers may precede plugin activation.
  const models = yield* opencode.model.list({ location }).pipe(
    Effect.map((response) => Array.map(response.data, (model) => `${model.providerID}/${model.id}`)),
    Effect.repeat({ until: (ids) => ids.length > 0, times: 50 }),
  )

  const openai = yield* opencode.integration.get({ location, integrationID: Integration.ID.make("openai") })
  const skills = yield* opencode.skill.list({ location })
  const config = yield* opencode.config.get({ location })

  const report = yield* encode({
    models,
    openai: Array.map(openai.data.connections, (connection) => connection.type),
    skills: skills.data,
    config,
  })

  yield* Console.log(report)
})

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
