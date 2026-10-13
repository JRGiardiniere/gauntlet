import { flow } from "effect/Function"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

// The Mod's options, as `register(on, options)` receives the values of
// plugin.json's `userConfig`: the Linear key `/plugin configure` keeps in
// secure storage. An empty key is no key.
const PluginOptions = Schema.Struct({ linear_api_key: Schema.NonEmptyString })

export const linearApiKeyFromOptions = flow(
  Schema.decodeUnknownOption(PluginOptions),
  Option.map(({ linear_api_key }) => linear_api_key),
  Option.getOrUndefined,
)
