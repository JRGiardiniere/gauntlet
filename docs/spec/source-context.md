# Finder citations and source context

Finders cite repository-relative file paths they actually read:

```json
{
  "file": "src/download.ts",
  "line": 24,
  "summary": "The download path can expose a document to another tenant.",
  "failure_scenario": "A signed-in user supplies another tenant's document ID.",
  "source_references": ["src/download.ts", "src/documents.ts"]
}
```

These paths are illustrative. The prompt asks for the primary file, relevant
callers/helpers/guards/configuration, and code that limits or could refute the
claim. The application collects whole files, preserving declarations and names
without requiring Finders to select line ranges. The primary `file` and `line`
still locate the Candidate.

The optional field maps to `Candidate.sourceReferences`. Shared Candidate schemas
preserve it in checkpoints and Dossiers; older outputs without references remain
valid. Pool need not interpret citations.

`assembleSourceContext(snapshotRoot, candidates, maxCharacters)` returns:

```ts
{
  files: [{ file: "src/documents.ts", text: "...complete file contents..." }],
  omissions: [],
  characters: 1234
}
```

The caller supplies the Run's frozen review directory, including its submitted
working-tree overlay. The collector does not reconstruct a snapshot from HEAD or
read the current checkout. Files are deduplicated by resolved repository path.
Candidates retain their references, so the output needs no reverse attribution.

The caller supplies the source character budget, reserving room separately for
claims, rubric, and other input. Files are admitted in Candidate/reference order;
files that do not fit are omitted whole and later smaller files may still fit.
There is no truncation. This is a character budget, not a tokenizer or a guarantee
that the eventual full Jev request fits.

Paths must remain within repository source after symlink resolution. Git metadata,
non-regular files, binary content, and files over the 1 MiB read limit are excluded.
Missing files and budget exclusions produce omissions naming the file and the
first affected Candidate. Candidates without references have a visible omission.
Other filesystem errors fail the operation instead of masquerading as missing
source. The caller should save the complete result alongside the eventual request.

The focused tests exercise complete snapshot source, shared unchanged dependencies,
reference persistence, missing context, path and symlink escapes, aggregate budget
exhaustion, duplicate budget accounting, and binary/oversized exclusions. They do
not assert internal loop structure or incidental formatting.

Pool behavior, verifier prompts, Jev invocation, orchestration, and delivery remain
unchanged. The collector is not connected to the live run. No live Finder or Jev
calls were made for this implementation. Whether Finders cite enough context, and
how often whole files fit, remain questions for the experiment.
