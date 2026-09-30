# Remote credential lifecycle prerequisite

This bounded THE-18 slice prepares the SSH/cloud backend ports. It introduces
internal host-backend helpers and optional runner cancellation; it does not yet
wire the credential-bearing adapters or establish remote product parity.

## Owned scratch directories

`OwnedCredentialDirectory` creates a private per-instance directory beneath
the caller's existing legacy scratch root. Files use generated names, exclusive
creation and mode 0600; directories use mode 0700. Caller-supplied peer IDs do
not become filenames. The file-kind argument is a closed `key`/`cred` enum,
checked at runtime as well as by TypeScript.

A small owner marker records the program's namespace/version, directory name
and process ID before any credential file is written. Startup cleanup requires
a matching valid marker and a definite dead-owner result. Only ESRCH proves a
dead PID; unknown errors and live owners preserve the directory. Unmarked
legacy files, malformed markers and unknown entries are retained with a
count-only warning, not adopted or recursively removed.

Existing symlinked path components are refused. Cleanup skips symlinked entries
and markers, opens markers without following symlinks, checks directory
identity again before removal, and does not follow nested symlinks. Tests prove
an outside fixture remains intact. These private filesystem checks are not a
claim to an adversarial same-user filesystem sandbox or race-free portable
openat semantics.

Teardown waits for its own file writes before removing only its own directory.
It leaves other active instances and the legacy root intact. No real user
credential directory is read, created or deleted by verification.

## Asynchronous work and cancellation

`BackendLifetime` makes close idempotent, prevents new work after close, rejects
late credential lookup results before dispatch resumes, and awaits owned I/O
before final cleanup. Cleanup failures remain visible. Reentrant close from an
abort listener still performs cleanup once.

The existing internal `runProcess` accepts an optional AbortSignal. An already
aborted call never spawns; an active abort stops/reaps the owned child and
cancels stream readers through the same cleanup path as I/O errors. Successful
completion removes the listener. POSIX group and Windows direct-child limits
remain as documented in the process-runner audit.

The combined lifecycle/owned-files/process/basic-backend run passes 45 guarded
tests across four files. Files contain dummy fixture strings only; child
processes are local fixtures or intercepted spawns. No persistent credential,
provider authorization or remote connection is provisioned.

All decisions are explicit lifecycle state, filename/marker grammar, filesystem
facts, PID probe results or declared enum membership. No credential value is
read for semantic judgment, logged, or sent to a model.
