# Channel conversation capabilities

This bounded adaptation follows SDK commit
`17eae838461a6529135fe2cad41332d2dc46cb27` on Jev main
`4415a34b7b5494f8062988dd9b11b1efa496ae34` (after the theme prerequisite).
It fixes the first and continued conversational turn paths on a served daemon,
and aligns the SDK runtime's own continuation runner with the same boundary.

## Reproduced behavior

The production-composition regression uses real runtime services, the real
daemon, shared-session broker, AgentManager, and a scripted provider that records
its received tool definitions. Before this change both the first Telegram turn
and a follow-up queued behind it received write/edit/exec and lacked profile.
The follow-up is released by the first agent's actual completion event.

The same two cases pass with the conversational tool set after the change.
Conversation retains `outsideContract: true` and its reply style. A locally typed
or already-confirmed continuation keeps its original task and normal capability
path; it does not inherit the conversational instruction or restricted tools.
Existing proposal delivery/acceptance, refusal, expiry, and raw authorized-work
checks remain in the compatibility run.

## Structural capability and provenance adaptations

The upstream patch is not copied wholesale:

- The conversational capability fragment is conditional on the existing
  continuation authorization decision. Upstream's unconditional spread would
  narrow confirmed contract work too.
- A conversational routing list may select fewer of read/find/fetch/profile,
  including an explicitly empty set. It cannot add write/edit/exec or another
  capability. These are exact tool identifiers, not a reading of user language.
- Profile admission requires a matching explicit `profile.ownerChannels` grant.
  Its empty shipped default grants nothing. Exact addresses and intentional
  surface wildcards remain supported. `occasions.nudgeChannel` is a delivery
  preference, not a personal-data read grant, even when explicitly configured.
  The existing standalone `resolveCaptureAuthority` nudge fallback is unchanged
  for legacy callers; this stricter condition belongs to the new tool admission.
- Profile includes personal reads as well as writes. If channel authority is
  denied, the capability list omits profile entirely; an explicit routing list
  cannot add it back. A real permitted-collaborator ingress on shipped defaults
  attempts both list and acknowledgment through the provider loop, and must
  receive unavailable-tool results with no synthetic store reads or mutations.
- Every first channel turn receives a bound capture decision, including a turn
  with no session id. Unknown origin is explicitly routed and untrusted, rather
  than inheriting the unbound profile tool's local-owner default.
- The current ingress channel id decides capture. An unrelated route attached
  to the same session cannot authorize the turn. Continuations use their exact
  input's bound route channel id, falling back to the input's external id when
  no channel id was supplied. Telegram bot usernames and Slack workspace ids
  are account identity, not the configured owner-channel address.
- `conversationalTurnSpawnOptions` accepts optional explicit `channel` identity
  and a narrowing `tools` list. Its previous input shape remains compatible;
  channel profile admission now requires the explicit owner grant above. The two composition roots in this
  slice always supply the explicit routed identity; other hosts adopting this
  seam must do the same for channel turns.

The two internal helpers added to spawn-contract.ts factor capability selection
and adapt the existing loosely typed config reader, including older schemas that
throw for unknown keys. Missing or malformed reads grant no channel authority. They introduce no config
keys, credential classifications, model-name inference, or language classifier.

## Acknowledgment authority

The profile tool previously put `acknowledge_occasion` above both the capture
preference and the bound authority checks. A turn denied profile authority could
therefore still silence an occasion. Acknowledgment now requires the bound
owner-authority decision, while deliberately remaining available to the owner
when `profile.conversationalCapture` is off. The capture preference does not
remove personal reads or acknowledgment from an explicitly authorized owner. Tests call the actual bound profile
tool and prove both no unauthorized occasion write and successful owner writes;
binding also leaves the original shared tool unchanged.

## Scope and accounting

The five changed production modules retain their existing inventory categories.
The shared surface gate remains JEV: its preexisting keyword/regex intent
classifier is still a separate unfinished conversion. This patch does not
replace, add, or claim completion of that semantic decision. The other edits
are exact capability membership, declared authorization/config values, typed
identity/provenance, and dependency composition.

No root-spawn task rewriting, WRFC controller, provider heuristics, context-window
catalog/caps work, configuration schema/readings, dependency/lockfile, or product
files are introduced. Nearby browser-judgment transport additions in the daemon
and runtime composition files must be composed, not overwritten. Source of truth
for this bounded work is THE-65; broad upstream parity remains open.
