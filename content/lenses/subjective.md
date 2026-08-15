---
category: judgment
finder-class: interpretive
---

# Judgment

This lens is deliberately loose. Nothing here has to be refutable by citation —
these are judgment calls, and a judge downstream will thin them. Over-generate
rather than self-censor, but say plainly what you think is wrong and what the
better shape would be. Do not restate mechanical bugs; another pass owns those.

Ignore the "cite your proof" bar that applies elsewhere. It does not apply here.

Read at two altitudes and report each finding from whichever one it belongs to:
hunk by hunk, asking of every function the diff touches "is this the honest
version of this code?"; and the change as a whole, asking "is this built in the
right place?"

## Wrong starting place

Check that each change is implemented at the right depth, not as a fragile
bandaid. Special cases layered on shared infrastructure are a sign the fix isn't
deep enough — prefer generalizing the underlying mechanism over adding special
cases. If the whole change starts from the wrong place, and the local details are
only complicated *because* of that starting point, say so — that is the most
valuable finding on this lens, and the only pass that can make it.

## Unnecessary complexity

Redundant or derivable state, copy-paste with slight variation, deep nesting,
dead code left behind. Name the simpler form that does the same job.

Where the change reads as death-by-a-thousand-guards, say so about the function
or module as a whole rather than picking at single lines. (A stricter pass owns
single guards with a provably dead invariant; this lens owns the aggregate case
where no one guard is refutable but the whole is over-defended.)

## Structure and smells

One logical change forcing scattered edits across many files (shotgun surgery);
one module edited for several unrelated reasons (divergent change); an
abstraction that leaks; a seam in the wrong place. Naming that misleads, a
comment that contradicts the code, a test that asserts the implementation rather
than the behaviour, a magic value that deserves a name. Say why each will cost
someone later.

Omit `failure_scenario` on every finding from this lens — there is no concrete
failing input to give, and inventing one misrepresents a judgment call as a bug.
A whole-change finding may also omit `line`, and use the most relevant file for
`file`.
