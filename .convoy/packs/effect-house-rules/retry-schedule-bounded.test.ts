import { retryScheduleBoundedRule as rule } from "./retry-schedule-bounded.ts"
import { productionFile, ruleTester } from "./rule-tester.ts"

const boundedSchedule =
  `Schedule.spaced("1 second").pipe(Schedule.upTo({ times: 2 }))`

const message =
  /HttpClient\.retryTransient must be explicitly bounded.*Schedule\.spaced\(\.\.\.\)\.pipe\(Schedule\.upTo\(\{ times: n \}\)\).*the effect skill/

const bounded = (name: string, code: string) => ({
  name,
  code,
  filename: productionFile,
})

const unbounded = (name: string, code: string) => ({
  name,
  code,
  filename: productionFile,
  errors: [{ message }],
})

const unlimited = (name: string, code: string) => ({
  name,
  code,
  filename: productionFile,
  errors: [{ message: /HttpClient\.withRateLimiter retries a 429 forever unless times is set/ }],
})

ruleTester.run("retry-schedule-bounded", rule, {
  valid: [
    bounded(
      "the shared transient schedule",
      `HttpClient.retryTransient({ schedule: transientRetrySchedule })`,
    ),
    bounded(
      "an inline bounded schedule",
      `HttpClient.retryTransient({ schedule: ${boundedSchedule} })`,
    ),
    bounded("a numeric times option", `HttpClient.retryTransient({ times: 2 })`),
    bounded(
      "the shared schedule imported under an alias",
      `import { transientRetrySchedule as retrySchedule } from "./retry.ts"\n`
        + `HttpClient.retryTransient({ schedule: retrySchedule })`,
    ),
    bounded(
      "a same-file identifier initialized with a bounded schedule",
      `const retrySchedule = ${boundedSchedule}\n`
        + `HttpClient.retryTransient({ schedule: retrySchedule })`,
    ),
    bounded(
      "a bounded schedule declared after the retry call",
      `HttpClient.retryTransient({ schedule: retrySchedule })\n`
        + `const retrySchedule = ${boundedSchedule}`,
    ),
    bounded(
      "an unbounded schedule capped by a numeric times option",
      `HttpClient.retryTransient({ schedule: Schedule.spaced("1 second"), times: 2 })`,
    ),
    bounded("an unrelated retry helper", `HttpClient.retry({ times: 2 })`),
    bounded(
      "a rate limiter with a numeric times",
      `HttpClient.withRateLimiter({ limiter, limit: 10, window: "1 second", times: 3 })`,
    ),
    bounded(
      "a data-first rate limiter with times 0",
      `HttpClient.withRateLimiter(client, { limiter, limit: 10, window: "1 second", times: 0 })`,
    ),
    bounded(
      "a bare withRateLimiter import with times",
      `withRateLimiter({ limiter, limit: 10, window: "1 second", times: 3 })`,
    ),
    {
      name: "a JavaScript file, which carries no retry vocabulary",
      code: `HttpClient.retryTransient({})`,
      filename: "/project/src/publisher.js",
    },
  ],
  invalid: [
    unbounded("retryTransient with empty options", `HttpClient.retryTransient({})`),
    unbounded("retryTransient with no options at all", `HttpClient.retryTransient()`),
    unbounded(
      "a destructured retryTransient import called bare",
      `retryTransient({ schedule: Schedule.spaced("1 second") })`,
    ),
    unbounded(
      "an unknown schedule identifier",
      `HttpClient.retryTransient({ schedule: retrySchedule })`,
    ),
    unbounded(
      "an inline unbounded schedule",
      `HttpClient.retryTransient({ schedule: Schedule.spaced("1 second") })`,
    ),
    unbounded(
      "the beta.90 Schedule.take spelling, which no longer exists",
      `HttpClient.retryTransient({ schedule: Schedule.spaced("1 second").pipe(Schedule.take(2)) })`,
    ),
    unlimited(
      "a rate limiter with no times",
      `HttpClient.withRateLimiter({ limiter, limit: 10, window: "1 second" })`,
    ),
    unlimited(
      "a data-first rate limiter with no times",
      `HttpClient.withRateLimiter(client, { limiter, limit: 10, window: "1 second" })`,
    ),
    unlimited(
      "a rate limiter that only disables response inspection",
      `HttpClient.withRateLimiter({ limiter, limit: 10, window: "1 second", disableResponseInspection: true })`,
    ),
  ],
})
