import { TargetIdentity } from "../domain/review-target.ts"

// How each report names the reviewed change, in one place: the Dossier's
// full line and the digest's short one.

const shortCommit = (commit: string) => commit.slice(0, 7)

// dossier.md's Target line.
export const describeTargetIdentity = (target: TargetIdentity): string =>
  TargetIdentity.match(target, {
    WorkingTree: ({ baseCommit, headCommit, repoRoot }) =>
      `working tree at ${repoRoot} (HEAD ${shortCommit(headCommit)}${
        baseCommit === undefined ? "" : `, since ${shortCommit(baseCommit)}`
      })`,
    Commits: ({ baseCommit, headCommit, repoRoot }) =>
      `commits ${shortCommit(baseCommit)}..${shortCommit(headCommit)} at ${repoRoot}`,
    PullRequest: ({ headCommit, number }) =>
      `PR #${number} (head ${shortCommit(headCommit)})`,
  })

// The digest's tally line.
export const describeTargetShort = (target: TargetIdentity): string =>
  TargetIdentity.match(target, {
    WorkingTree: ({ baseCommit, headCommit }) =>
      `working tree @ ${shortCommit(headCommit)}${
        baseCommit === undefined ? "" : ` since ${shortCommit(baseCommit)}`
      }`,
    Commits: ({ baseCommit, headCommit }) =>
      `commits ${shortCommit(baseCommit)}..${shortCommit(headCommit)}`,
    PullRequest: ({ number }) => `PR #${number}`,
  })
