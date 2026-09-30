/**
 * surface.ts, the daemon's single surface-root identifier.
 *
 * Every piece of the daemon's own on-disk state (sessions, recovery snapshots,
 * checkpoints, the transcript journal, watchers, triggers, control-plane stores)
 * lives under `.goodvibes/<surface root>/`. The segment used to be spelled as a
 * bare string literal at each call site, which is how a writer and a reader
 * ended up disagreeing about where the last-session pointer lives.
 *
 * ── Why the daemon's surface root is still `tui` ────────────────────────────
 *
 * Because that is where the running daemon's state already is. Every store
 * this daemon has written on every installed machine, sessions, approvals,
 * watchers, devices, channel policies, the code index, sits under
 * `.goodvibes/tui/`. Renaming the segment here would not move that state; it
 * would make the daemon stop finding it, silently, on machines that have been
 * running for months.
 *
 * The rename is a migration, not a constant edit: it needs a copy-forward pass
 * with a receipt, the same shape the SDK already performs for the unscoped →
 * scoped move, plus the live-install rehearsal that goes with it. Until then
 * this constant carries the reason so nobody "tidies" it.
 */
export const GOODVIBES_DAEMON_SURFACE_ROOT = 'tui';
