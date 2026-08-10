import { isTypeScriptFile } from "./utils.js"

const isSanctionedPlatformImport = (source) =>
  source === "@effect/platform-node" || source.startsWith("@effect/platform-node/")

const isForbiddenPlatformImport = (source) =>
  (source === "@effect/platform"
    || source.startsWith("@effect/platform/")
    || source.startsWith("@effect/platform-"))
  && !isSanctionedPlatformImport(source)

const messageFor = (source) =>
  `Do not import "${source}"; it is not part of this Effect v4 platform. Use the in-core effect/unstable modules, or @effect/platform-node (the only sanctioned platform package) — house-style rule 2, docs/effect-house-style.md.`

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow @effect/platform and @effect/platform-bun imports",
    },
  },
  create(context) {
    if (!isTypeScriptFile(context.filename)) return {}

    return {
      ImportDeclaration(node) {
        const source = node.source.value
        if (isForbiddenPlatformImport(source)) {
          context.report({ node: node.source, message: messageFor(source) })
        }
      },
    }
  },
}
