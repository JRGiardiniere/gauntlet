import * as Array from "effect/Array"

// Lens selection is membership, never caller-visible priority. Normalize the
// chosen source by removing repeated names; retained first-occurrence order is
// deterministic plan identity, not a scheduling promise.
export const resolveLensNames = (
  callerNames: ReadonlyArray<string> | undefined,
  defaultNames: ReadonlyArray<string>,
): ReadonlyArray<string> => Array.dedupe(callerNames ?? defaultNames)
