# Ledger commit hashes after the 2026-09-27 email rewrite

On 2026-09-27 every commit on `main` was rewritten so that author and committer are Mike Davis <mgd34msu@gmail.com>. File trees, dates and messages are unchanged (checked with a diff of `%T %at %ct %s` and of every full message), but every hash from the first affected commit on changed, and `origin` was force-pushed at 6babc77.

The vibecheck-jev ledger does not let a completed work record change, so the tasks below still record the old hash. This table gives the commit on `main` with the same subject.

| Task | Recorded hash | Commit on main | Subject |
|---|---|---|---|
| E.1 | `2f03c8c` | `3eb7510` | Read error meaning with Jev instead of regex phrase lists |
| E.14 | `6d18860` | `b72c759` | Carry the goodvibes-sdk tooling, docs and repo config into the engine |
| E.2 | `1a69233` | `bf19525` | Point the toolchain pin gate at the workspace engine |
| E.3 | `61d2144` | `14224e6` | Read recommendations, collapse handoffs and lexical code search through Jev |
| E.9 | `85858aa` | `9e1dc34` | Read delivery and automation failure transience through Jev before retry, cooldown or dead-letter |
| J.2 | `040b9b2d0e1e` | `040b9b20994c` | Add the judgment port and the System One transport (the recorded full hash never named a real commit; only its first seven characters match this one, which the rewrite did not change) |
| R.1 | `804052e` | `c988560` | Keep the WRFC defaults for contract commits and gates |
| R.2 | `c51c685` | `00d3226` | Read child failures by stamped reason or Jev, and phase transport by readFailure |
| R.3 | `1470638` | `f48b068` | Add contract evidence, checks, nudges and their batteries (R.3) |
| R.4 | `0da5db9` | `17f665e` | Add contract planning: plan schema, Jev plan checks and the planner loop (R.4) |
| R.5 | `448635c` | `7130a6f` | Fail the group that holds a failed unit when its contract fails |
| R.6 | `7ee1bcc` | `61fec2c` | Read the attempt an owner asks for with contract.owner-pick |
| R.7 | `cdde285` | `5af9474` | Let the route selector pick each best-of-N attempt's model |
| R.8 | `24a119a` | `a024dc2` | Move every consumer to the contract events and show the contract tree in the fleet (contract runner R.8) |

## Recorded hashes that never named a commit

These were written into the ledger by expanding a short hash by hand instead of resolving it with `git rev-parse`. The commit on main is the one the short hash names.

| Task | Recorded hash | Commit on main | Subject |
|---|---|---|---|
| J.2 | `040b9b2d0e1e` | `040b9b20994c` | Add the judgment port and the System One transport |
| R.9 | `a2937977a5e8` | `a293797309d0` | Resume contracts after a restart and carry contract trees in sessions (contract runner R.9) |
