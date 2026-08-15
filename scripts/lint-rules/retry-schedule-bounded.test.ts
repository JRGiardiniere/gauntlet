import { retryScheduleBoundedRule as rule } from "./retry-schedule-bounded.ts"
import { productionFile, ruleTester } from "./rule-tester.ts"

const boundedSchedule = `Schedule.spaced("1 second").pipe(Schedule.take(2))`

const message =
  /HttpClient\.retryTransient must be explicitly bounded.*Schedule\.spaced\(\.\.\.\)\.pipe\(Schedule\.take\(\.\.\.\)\).*house-style rules 13\/23.*docs\/effect-house-style\.md/

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
    bounded("an unrelated retry helper", `HttpClient.retry({ times: 2 })`),
  ],
  invalid: [
    unbounded("retryTransient with empty options", `HttpClient.retryTransient({})`),
    unbounded("retryTransient with no options at all", `HttpClient.retryTransient()`),
    unbounded(
      "an unknown schedule identifier",
      `HttpClient.retryTransient({ schedule: retrySchedule })`,
    ),
    unbounded(
      "an inline unbounded schedule",
      `HttpClient.retryTransient({ schedule: Schedule.spaced("1 second") })`,
    ),
    unbounded(
      "an unbounded schedule even when times is also present",
      `HttpClient.retryTransient({ schedule: Schedule.spaced("1 second"), times: 2 })`,
    ),
  ],
})
