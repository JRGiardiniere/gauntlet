import { noEffectPromiseRule as rule } from "./no-effect-promise.ts"
import { productionFile, ruleTester, testFile } from "./rule-tester.ts"

ruleTester.run("no-effect-promise", rule, {
  valid: [
    {
      name: "Effect.promise inside a unit test",
      code: `const read = Effect.promise(() => fetch("/a"))`,
      filename: testFile,
    },
    {
      name: "Effect.tryPromise with a typed error",
      code: `const read = Effect.tryPromise({
        try: () => fetch("/a"),
        catch: (cause) => new ReadError({ cause }),
      })`,
      filename: productionFile,
    },
    {
      name: "a promise member on another object",
      code: `const done = Deferred.promise(deferred)`,
      filename: productionFile,
    },
  ],
  invalid: [
    {
      name: "Effect.promise called in production",
      code: `const read = Effect.promise(() => fetch("/a"))`,
      filename: productionFile,
      errors: [{ message: /Use Effect\.tryPromise with a typed error/ }],
    },
    {
      name: "Effect.promise passed as a value",
      code: `const bridge = Effect.promise`,
      filename: productionFile,
      errors: [{ message: /only for a Promise built never to reject/ }],
    },
  ],
})
