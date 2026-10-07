## Touched files, whole

The post-change text of every file the diff touches (a file the change
deletes has none). It is already in your context: do not `read` these files
to see them.

{{TOUCHED_FILES}}

## Related unchanged files

Unchanged files that a touched file references, and unchanged files that
reference a touched file, tests included, chosen to fit a size budget: the
files the touched files reference come first, so some referencing files may
be left out. They are already in your context too: start from them, and still
use your tools for anything they do not cover.

{{RELATED_FILES}}
