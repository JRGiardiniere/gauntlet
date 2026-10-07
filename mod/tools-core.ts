// The slice of the review program gc-cli-tools bundles: the four emit
// tools' OutputContracts (their JSON Schema to register, their strict
// decoder to answer each call with) and the ReviewWorkspace fence. The
// engine re-runs the same decoder on the same arguments before it executes
// an emit, so the verdict the agent hears and the one the review records
// come from one function.
import * as Result from "effect/Result"
import { flow } from "effect/Function"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import {
  checkOutputContract,
  EmitFindings,
  EmitPool,
  EmitVerdicts,
  type OutputContract,
  projectOutputContract,
} from "../src/harness/output-contract.ts"
import { EmitJudgments } from "../src/stages/judgment/output-contract.ts"

import type { FencedToolInput } from "./fence.ts"

export { FENCED_TOOLS, fencedPathOf, isInsideRoot } from "./fence.ts"

const FencedInput = Schema.Struct({
  file_path: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
})
const decodeFencedInput = Schema.decodeUnknownOption(FencedInput)

// The location arguments of a Read, Grep or Glob call as tool.check hands
// them over (unparsed); anything else names no location.
export const fencedInputOf = flow(decodeFencedInput, Option.getOrElse((): FencedToolInput => ({})))

const contracts: ReadonlyArray<OutputContract<unknown>> = [EmitFindings, EmitPool, EmitVerdicts, EmitJudgments]

// What `$.tool.register` takes for each emit tool: the bare JSON Schema, so
// arrays arrive as arrays.
export const emitTools = contracts.map((contract) => ({
  name: contract.toolName,
  description: contract.description,
  inputSchema: { ...projectOutputContract(contract).schema },
}))

// The rejection reason, or undefined when the arguments decode.
export const checkEmit = (toolName: string, args: Schema.Json): string | undefined => {
  const contract = contracts.find((candidate) => candidate.toolName === toolName)
  if (contract === undefined) return `${toolName} is not a Gauntlet emit tool`
  return Result.match(checkOutputContract(contract)(args), {
    onFailure: (error) => String(error),
    onSuccess: () => undefined,
  })
}
