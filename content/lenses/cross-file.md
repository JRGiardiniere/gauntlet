# Cross-file tracer

For each function the diff changes, find its callers (grep for the symbol) and
check whether the change breaks any call site: a new precondition, a changed
return shape, a new exception, a timing/ordering dependency. Also check callees:
does a parallel change in the same PR make a call unsafe?

The diff above is complete, but the files it does NOT touch are not included —
tracing callers is exactly the work this lens exists to do, so use bash (rg /
grep) and read freely on unchanged files.
