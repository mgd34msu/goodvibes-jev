# SSH backend hoist

Source: `mgd34msu/goodvibes-daemon` at
`443e5ee4d6cda0d36d57e2886398d0836074a4a9`, remote `backends/ssh.ts`
and the shared backend/route-gating tests.

The factory now lives in engine `runtime/remote/host/backends`, exported through
runtime operations. It preserves the SSH identity/port, batch/connect options,
remote-shell command/args, optional env/stdin, 60-second connection persistence
and timeout-to-124 behavior. All SSH execution is intercepted in verification.

## Identity and lifetime corrections

The first 13-case regression run against the imported source passed two and
failed eleven. The port fixes concurrent duplicate key creation, stale endpoint
pool reuse, early key deletion during rotation, peer-ID path traversal, known
key disclosure, cross-instance deletion, late lookup after close and incomplete
teardown.

Pool bindings include the credential reference, host, username and port. A lease
is reserved before awaiting identity creation, so a concurrent destination/key
change cannot remove a key an active command still needs. Retired identities
are cleaned after their last lease; failed lookups are evicted for retry.
OpenSSH recommends distinguishing host, port and user in shared connection
identity. [OpenSSH configuration manual](https://man.openbsd.org/ssh_config.5#ControlPath)

Keys use the shared per-instance owned scratch lifecycle under the legacy
`ssh-keys` root. Caller peer IDs never form paths. Known key bytes are removed
from returned output by literal equality; credential-store errors become fixed
typed errors. This is not detection of unrelated secrets or transformed key
fragments.

Teardown cancels active owned CLI work, waits for leases, requests an existing
multiplexing master to exit, then removes private key material. The cleanup
command uses the exact owned socket, `-O exit` and `-F none`, rather than reading
unrelated SSH config. [OpenSSH client manual](https://man.openbsd.org/ssh.1#O)

Master cleanup failures remain visible even after private files are removed.
A deliberately detached master can still survive a hard process crash until
its normal idle expiry; this is not a process sandbox or a claim to immediate
crash-time remote cancellation.

Owned socket paths use a conservative 100-byte budget. Longer configured homes
run with connection sharing disabled and a warning rather than failing the
command on an unusable Unix socket path. The tests emulate that branch without
creating unowned short-path temp directories. This is a filesystem resource
bound, not a judgment about the command or peer.

## Original tests and verification boundary

The original backend and route-gating files are now present in the engine.
Command grammar, exit codes, timeout, stdin, local allowlists, admin denial,
remote-shell args and Docker env-only credential assertions remain. Four
cleanup fixture cases change intentionally: unowned legacy files are retained,
and crash cleanup is proved with valid owner markers plus dead-PID evidence.
Cloud spawning is mocked explicitly instead of assuming gcloud is absent.

The combined remote run passes 134 guarded tests across ten files. Fixture
credentials are dummy strings; external CLIs, control sockets and provider
connections are mocked. Only the runner's isolated local child processes are
real. No user credential store or remote machine is contacted.

The all-backend factory, dispatcher/service, daemon composition and operator
registration path remain later slices. Upstream release reconciliation and
actual product parity remain separate completion gates.
