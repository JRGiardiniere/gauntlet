// A Bun preload that reports every `@opencode/*` import on stderr, so a test
// can show which commands never load OpenCode.
Bun.plugin({
  name: "trace-opencode",
  setup(build) {
    build.onResolve({ filter: /^@opencode\// }, (args) => {
      process.stderr.write(`opencode-import ${args.path}\n`)
      return undefined
    })
  },
})
