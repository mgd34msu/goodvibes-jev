# Owned test-runner temporary state

## Parent and child ownership

- Every `runOwnedTestChild` call creates a fresh parent-owned temp root, establishes
  all three child temp variables before startup, and removes only that root after
  child/output teardown. Pre-existing names, escaping names, and root replacements
  are refused instead of deleted.
- Project helpers allocate within the official private tree and immediately use
  the same canonical registry as the actual runner preload. Raw invocation is
  rejected before allocation. Prefix, uniqueness, existence, registration, and
  adapted root behavior remain explicitly tested.
- Registry admission and removal reject outside roots and symlink escapes,
  including independent-registry roots and replacement paths. The bounded drain
  observes late writers, retains unsuccessful cleanup, and reports real survivors.
  Parent cleanup is the abrupt-exit backstop.
- Official test, leak-scan, and wake-sweep entrypoints request POSIX ownership.
  The public `ownProcessGroup` default remains false, preserving its compatibility
  behavior. On parent death, the child watchdog signals only a group explicitly
  created by its parent, and only after an ESRCH parent probe proves absence.
  EPERM and unknown probe errors do not authorize a group signal.
  Ordinary descendants, cancellation, hard exits, and
  late-writing descendants are measured before fixture cleanup.
- Stale canonical test roots require matching ownership metadata and a dead owner.
  Live or unknown ownership, historical unmarked roots, links, worktrees, and
  retained evidence are preserved. Arbitrary cwd `.test-tmp` data is not swept.

## Settlement and conservative failure

Teardown waits within a bounded deadline for no live process-group members,
re-signals racing members and requires two quiet observations before root
cleanup. On Linux, membership observation reads only process state and group ID
from `/proc/<pid>/stat`; zombies cannot write. Unknown membership or signalling
errors fail the runner and preserve the owned root with a retention marker.
Mark canonical owned ancestors as well so outer cleanup cannot erase evidence.

## Validation

Use real-process EPERM/unknown fault injection to require retained roots and
reaped direct children before fixture cleanup. Watchdog cases cover a live
parent, EPERM, unknown probes and genuine hard-parent death. Late-writer tests
assert the descendant is dead before cleanup, not merely that a signal was sent.
Keep helper consumers, lifecycle/output/containment, timeout/isolation/discovery,
wake-sweep and actual leak-scan entrypoint coverage. Overlapping test selections
are not unique coverage counts.

Normalized installed-package validation checks emitted registry/preload closure,
safe Node import without Bun, public declarations, actual preload activation and
cleanup after normal and hard-exited children. Explicitly capture output so a
Bun banner cannot be mistaken for JSON. Serialize installed-consumer TypeScript
and other compiler work through the canonical compiler lock. Keep emitted
artifact, type and temporary-file architecture checks.

This POSIX ownership contract covers ordinary descendants. It does not promise
control over deliberately detached descendants or Windows child-tree cleanup.
Unknown historical roots, source trees, dependencies, caches and retained evidence
are not cleanup targets.
