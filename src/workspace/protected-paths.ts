import * as Array from "effect/Array"

// What the ReviewWorkspace never serves an agent, through a tool or through
// inlined context: secrets, and the snapshot's `.git` file, which names the
// reviewed repository's own git directory. Paths are snapshot-relative.
const GIT = ".git"

const SECRETS = ".env"

const isProtectedSegment = (segment: string) => segment === GIT || segment.startsWith(SECRETS)

export const isProtectedPath = (relative: string): boolean => Array.some(relative.split("/"), isProtectedSegment)

// The same paths as OpenCode permission resources, where `*` spans `/`.
export const PROTECTED_RESOURCES: ReadonlyArray<string> = Array.flatMap(
  [`${SECRETS}*`, GIT, `${GIT}/*`],
  (resource) => [resource, `*/${resource}`],
)
