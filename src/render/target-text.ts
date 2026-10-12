import { TargetIdentity } from "../domain/review-target.ts"

// How each report names the reviewed change, in one place: the Dossier's
// full line, the digest's short one, and the page's title and subject.

export const shortCommit = (commit: string) => commit.slice(0, 7)

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1)

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

// The page's title: the repository and the range, and the kind of change
// in its Subject field.
export const describeTargetForPage = (target: TargetIdentity) => ({
  subject: `${basename(target.repoRoot)}${
    TargetIdentity.match(target, {
      WorkingTree: () => "",
      Commits: () => "",
      PullRequest: ({ number }) => ` #${number}`,
    })
  }`,
  range: TargetIdentity.match(target, {
    WorkingTree: ({ headCommit }) => `working tree on ${shortCommit(headCommit)}`,
    Commits: ({ baseCommit, headCommit }) => `${shortCommit(baseCommit)}‥${shortCommit(headCommit)}`,
    PullRequest: ({ baseCommit, headCommit }) => `${shortCommit(baseCommit)}‥${shortCommit(headCommit)}`,
  }),
  kind: TargetIdentity.match(target, {
    WorkingTree: () => "Working tree",
    Commits: () => "Commits",
    PullRequest: ({ number }) => `Pull request #${number}`,
  }),
})
