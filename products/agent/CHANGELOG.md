# Changelog

Product-facing release notes for GoodVibes Agent.

## 2.1.0 - 2026-09-30

- **Added: themes.** display.theme picks goodvibes (the default), goodvibes-neon, catppuccin, tokyonight, dracula, nord, gruvbox, one-dark, rosepine, solarized, github, or system, which follows the terminal's own palette, under tmux too. A theme you already chose is kept.
- **Added: a calmer screen.** Modals on one surface kit replace the sidebar and tab strip (an Activity modal holds them), a one-row header with an empty row under it, an input area that holds only input, a status line with the context bar, and the throbber on its own row above the input area with half-row gaps around it.
- **Added: a back-to-bottom pill** while the output is scrolled back. Esc returns to the live output and never interrupts the turn.
- **Added: notifications name the work** on every channel, including Slack and Discord. The behavior.notificationsMetadataOnly setting sends metadata only and is off by default. System notices become toasts kept in a /notifications history, one entry per event.
- **Added: /context window and /status** show the model's context window and where it came from; a remote model with no real window takes it from the models.dev catalog.
- Changed: WRFC chains run isolated in their own git worktree, automatically, with no step for you. A passed chain commits only its own changes plus edits made by GoodVibes' own tools, runs your git hooks, and leaves your other uncommitted edits in place.
- Fixed: indented read bodies, wrapped code lines, finished turn headers, ended processes no longer counted as running, and printed command output that survives resizes.
- Changed: every open dependency advisory is closed; undici, brace-expansion, the Anthropic client (0.92), qs, body-parser, ip-address, fflate, fast-uri, js-yaml and sharp move to patched versions.
- Changed: pins move to sdk/terminal-shell/toolchain 2.1.0 and daemon 1.29.0; reusable-workflow pins repoint to the 2.1.0 release commit.

## 2.0.21 - 2026-08-23

- **Fixed: an error that is not the model's fault no longer blames the model.** Platform runtime 2.0.23 inside: failure hints name the part that actually failed, so a network, auth, or configuration problem stops sending you to check the model or its key.
- Changed: calendar authentication reports its real state, and a provider's authentication status folds its routes into one aggregate (platform runtime 2.0.23).
- Changed: catalog providers that publish no routes get routes derived from their environment configuration, so an env-only provider works instead of sitting invisible.
- Changed: the reasoning-effort setting is served whole by the pinned platform: the level persists, null clears it, and the options follow the selected model.
- Changed: pins move to sdk/terminal-shell/toolchain 2.0.23 and daemon 1.28.25; reusable-workflow pins repoint to the 2.0.23 release commit. A repo-wide prose cleanup rides along with no behavior change.

## 2.0.20 - 2026-08-22

- **Fixed: this Agent adopts the running daemon again.** The adoption gate compared the daemon's 1.28.x artifact version against the platform's 2.x version and refused every adoption since sdk 2.0.0, silently running without the shared daemon. It now band-checks the platform build the daemon reports.
- Changed: a dead subscription login is stamped and shown as ended everywhere a status renders, and a near-expiry token refreshes silently before the send (platform runtime 2.0.22).
- Changed: a machine with no microphone is reported as that, once, in plain words, with a gentle retry. A busy device keeps prompt retries and the crash latch.
- Changed: pins move to sdk/terminal-shell/toolchain 2.0.22 and daemon 1.28.24; reusable-workflow pins repoint to the 2.0.22 release commit.

## 2.0.19 - 2026-08-21

- **Fixed: a dead OpenAI subscription login recovers or says so honestly.** Platform runtime 2.0.21 inside: a token OpenAI rejects mid-lifetime gets one shared, time-bounded refresh attempt and one retry before anything is surfaced; when the session truly is over, the error names the subscription session and says to sign in again, never "check your API key". The bundled daemon moves to 1.28.23 with the same runtime.

## 2.0.18 - 2026-08-21

- **Fixed: the daemon installed alongside this Agent is current again.** The daemon dependency moves from 1.28.19 to 1.28.22, so an Agent install no longer carries a daemon three platform releases behind the Agent's own runtime pin. The jump brings the daemon's durable daily budget, the recorded owner-approval verb for checkout, the durable in-flight checkout journal, and boot recovery for checkouts interrupted by a crash.
- Changed: 2.0.17 shipped hours earlier with the stale daemon pin; this release exists to correct it and changes nothing else.

## 2.0.17 - 2026-08-21

- **Fixed: the workspace no longer offers routes that go nowhere.** Around 70
  emitted "Agent Workspace" routes named views that were never registered; a
  tap on one dead-ended. Every emitted route now resolves against the real
  workspace category registry, and a guard test walks all 35 emitting files
  so a phantom route fails the build.
- Changed: the Google setup runbook is regenerated from the platform runtime
  2.0.20 generator, and with its one sdk-owned `/status` phrase gone, the
  phantom-command scan covers the runbook whole again; the last per-file
  exemption is deleted.
- Changed: platform runtime pin moves to 2.0.20 (payments boot recovery on
  the daemon side; no Agent-side behavior change). The reusable-workflow pins
  repoint to the 2.0.20 release commit.

## 2.0.16 - 2026-08-21

- **Fixed: two processes writing to the same local store at once can no longer corrupt it.** Every on-disk JSON store this Agent keeps (calendar, notes, personas, routines, skills, research, schedules, and more) had its own hand-rolled "write to a `.tmp` path, then rename" implementation, each one copied from the last, all sharing one fixed temp file name. This Agent and a one-shot `goodvibes ...` CLI invocation writing to the same store at the same moment could splice their bytes together, and the next read of that store would fail to parse, losing its entire history rather than just the one write in flight. All 22 store writers now go through a single shared writer, each write picking a temp name only that write can ever hold, and the build fails if a hand-rolled temp path is ever reintroduced. A concurrency test spawns four real OS processes hammering one store at once and proves no torn file and no lost update.
- Changed: that shared store writer now delegates its write step to the platform runtime's own atomic-write primitive (platform runtime 2.0.19), which fsyncs the write before renaming it into place, a stronger guarantee than the hand-rolled version gave: a crash immediately after a store write can no longer lose it. New store files are written owner-read-write only (mode 0600) rather than the process's default permissions, tighter than before for files that can hold personal data.
- Changed: the set of channels a schedule can deliver to is now defined in one place (`src/agent/schedule-delivery-targets.ts`) instead of six separate copies of the same list, so adding or removing a delivery surface can no longer update five of six.
- **Fixed: a release build could ship a miscompiled binary.** The release workflow's setup step silently ignored the `bun-version` input the reusable workflow passed it and always built with bun 1.3.10, a version documented to miscompile `bun build --compile` output. Every build leg now pins bun 1.3.14, which compiles a correct bundle on every platform target, and the release toolchain is pinned to an exact published version at every release call site instead of resolving `latest` from npm, so a release run cannot silently drift under a moving tag.
- Changed: the automatic release job no longer treats a pushed git tag as proof that a release actually ran. A failed dispatch right after the tag push used to leave the tag on the remote with no release run behind it, and the next automatic attempt saw the tag and walked away. It now checks for a completed `release.yml` run at that tag before calling the job done, and re-dispatches if none is found. The release concurrency group is now keyed on the tag actually being released instead of collapsing every automatic release into one shared group, so a queued release can no longer be evicted by an unrelated one starting.
- Changed: the SDK's reusable release workflows are pinned to a fixed commit instead of floating on the SDK repo's default branch, so a change to those workflows can no longer alter what runs with this repo's publish credentials without a deliberate bump here.
- Changed: the bundled platform runtime and terminal-shell are now 2.0.19 (up from 2.0.17), and the daemon installed alongside this Agent stays 1.28.19.

## 2.0.15 - 2026-08-15

- **Fixed: signing in to a provider subscription on any surface now reaches the daemon that runs the turns** (platform runtime 2.0.17). Subscription sessions were stored per surface while turns run in the daemon — a fresh ChatGPT sign-in changed nothing and every turn kept failing on a revoked stale token. Sessions now live in the shared tier; existing records fold in automatically on first read.
- **Fixed: conversations through strict OpenAI-compatible gateways work again** (platform runtime 2.0.17). The edit tool's schema declared its occurrence union with the JSON-Schema keyword `oneOf`; gateways like abacus RouteLLM recently began rejecting any chat request whose tool schemas carry it — "Extra inputs are not permitted" — which failed every turn through such a provider regardless of the prompt. The union is now `anyOf`, which validates identically and is what OpenAI's own function-calling schemas use.
- Changed: a wire-compatibility test now walks every tool schema the platform ships and fails if `oneOf` reappears, so one tool's schema can never again take down every turn through a strict gateway.
- Changed: the bundled platform runtime is 2.0.17 and the daemon installed alongside this Agent is 1.28.19, which carry the same fixes.
- Verified live end to end: a real prompt through the built binary routed via abacus RouteLLM and answered, where before the fix the same request failed with the gateway's validation error.
- No behavior change for providers that accepted the old schema: `anyOf` and `oneOf` validate identically for the edit tool's disjoint string/integer branches.

## 2.0.14 - 2026-08-15

- **Fixed: typing can no longer summon a system authentication prompt over the screen.** Submitting a turn acquires a keep-the-machine-awake inhibitor while work runs (`power.inhibitWhileWorking`). On hosts whose polkit rules require authentication for that — typical for tmux or SSH sessions the login manager does not count as an active local seat — systemd registered an interactive auth agent on the controlling terminal: "authentication is required to inhibit system sleep", painted raw over the UI on every submitted message. The inhibitor is now requested with `--no-ask-password` (platform runtime 2.0.15), so a refusal is an immediate silent exit and the platform simply runs without the inhibitor, exactly as it does on hosts with no login manager at all.
- Changed: the refusal path is pinned by a test on the inhibitor's exact argument list — no systemd tool this platform spawns may ever prompt on the user's terminal.
- Changed: `power.inhibitWhileWorking: false` remains the full opt-out from keep-awake, and `power.keepAwake` the manual hold; both unchanged.
- Changed: the bundled platform runtime is 2.0.15 and the daemon installed alongside this Agent is 1.28.18, which carry the same fix.
- No behavior change for hosts where the inhibitor is granted: work still holds the machine awake and releases when work drains.

## 2.0.13 - 2026-08-08

- **Fixed: enabling voice makes the Agent actually speak.** Two defects stacked. The always-speak rule — voice enabled means every response is spoken, no per-turn arming — existed in the terminal app and had never been ported here. And deeper: the Agent's conversations run inside the daemon, and a daemon-hosted turn's events never reached the local bus the speech pipeline listens to — so even explicitly-armed spoken turns were silent. Hosted turn frames are now bridged onto the runtime bus through the platform's typed emitters, and `ui.voiceEnabled` arms every submitted turn. Turn voice on; every reply is read aloud.
- **Fixed: spoken output reads prose, not markdown** (platform runtime 2.0.14). Formatting marks — bold and italic asterisks, heading hashes, link syntax, list bullets, table pipes — are stripped before synthesis, and fenced code blocks are announced ("Code block omitted.") instead of being read character by character.
- **Fixed: post-wake capture ends when you stop talking, on real microphones** (platform runtime 2.0.14). A headset's automatic gain control ramping back up after speech no longer holds the microphone open — the silence floor follows the room through the whole capture — and breath ticks shorter than `voice.wake.speechRetriggerMs` (new setting, default 150 ms) no longer restart the silence countdown. The pause window is unchanged: a natural mid-sentence pause under `voice.wake.silenceStopMs` never cuts you off, sustained speech always resets the clock, and the floor can never rise into your voice (capped at a third of your tracked speech level).
- **Every completed wake capture now leaves a receipt** in the voice diagnostics: the floor it started with, where it ended, why the capture stopped, how long it ran, and how many short bursts it absorbed — so capture behavior is a set of numbers, not a feeling.
- Changed: the bundled platform runtime is 2.0.14 and the daemon installed alongside this Agent is 1.28.17, which carry the same capture and spoken-output behavior.

## 2.0.12 - 2026-08-07

- **Supersedes 2.0.11, whose release never published.** Its compiled-binary check failed on one build leg, and the failure was real. Everything listed under 2.0.11 ships here, plus the fix for what stopped it.
- **Fixed: the compiled Agent no longer plays a build-order lottery at load.** The Agent's runtime barrel read over a hundred values off the platform's runtime namespace objects at module scope. The single-file compiler emits module bodies in an order that varies build-to-build, and such a read can land before the module that defines the binding — the binary then dies at load with a ReferenceError on some builds of identical source. That is exactly what CI observed for 2.0.11: the same commit failed the binary check, passed it on a rerun, and failed again on the macOS build leg. Every one of those reads is now a live re-export resolved by the module system, which cannot be reordered out from under it (platform runtime 2.0.13).
- **The build check now catches this class before it ships.** The post-build check reads the compiled artifact itself and fails if the eager-read pattern is present — even on a build that happened to boot, because the next rebuild of the same source could reorder and die. A lucky ordering can no longer pass for a fixed one.
- **A machine that cannot reach the platform says so and fixes itself** (from 2.0.11): a stopped daemon service plus a stale `daemon.enabled: false` left a laptop unusable for weeks with no explanation. The Agent now recognises that state at startup, names both halves of the problem in one plain line, and offers a one-keypress repair: write the setting, install or start the daemon's service, wait for it to answer, and record every step. Declining changes nothing and is not asked again for the session; `goodvibes-agent run` never interrupts a script — it states the diagnosis on the error stream and carries on.
- **A setting that quietly changed meaning is corrected once, out loud** (from 2.0.11): `daemon.enabled: false` used to mean "no daemon inside this app"; after the daemon became its own product it silently came to mean "do not look for a daemon at all". A stored `false` is reset to true one time, with a notice explaining what changed, and the correction is recorded so it never runs twice — a `false` set from here on is yours and is kept.
- **The screen belongs to the Agent before the first frame is painted** (from 2.0.11): one frame could render before the terminal switched to the alternate screen, leaving shell-screen residue at quit and a garbled first paint (missing sidebar, half-drawn header). Rendering now waits for the screen handoff.
- **Capture ends when the room goes quiet** (from 2.0.11, platform runtime 2.0.12): the silence floor is measured against the room's own noise from the audio just before the wake fired, `voice.wake.silenceFloorRms` pins it manually, and `voice.wake.captureMaxSeconds: 0` removes the capture ceiling for long dictation.

## 2.0.11 - 2026-08-06

- **Fixed: a machine that cannot reach the platform can now say so and fix itself.** A laptop sat unusable for weeks with two things wrong at once: its daemon service was stopped, and its settings carried `daemon.enabled: false`. Neither alone is a fault — a stopped service is started for you at boot, and a deliberate `false` is honored — but together the flag turned off the very search that would have found the problem, so the Agent came up with no host, no explanation, and no way back. A person had to be handed shell commands. The Agent now recognises that state at startup, says in one plain line what is wrong with both halves named, and offers to repair it. One keypress: it writes the setting, has the daemon install or start its own service, waits for the daemon to actually answer, and records every step it took in the activity log. Declining changes nothing at all and is not asked again for the rest of the session. `goodvibes-agent run` never interrupts a scripted run to ask — it states the same diagnosis on the error stream and carries on.
- **Fixed: a setting that quietly changed meaning is corrected once, out loud, instead of being obeyed forever.** `daemon.enabled: false` used to mean "do not run a daemon inside this app", which was a reasonable thing to want and the documented way to want it. After the daemon became its own product the same value means "do not look for a daemon at all" — so a preference about process layout became a switch that cut a machine off from the platform, without anybody choosing that. A stored `false` is now reset to true one time, with a notice that says what it used to mean, what it means now, and that turning it off again is one settings change away. The correction is recorded so it can never run twice: a `false` you set from here on is yours and is kept, on every launch after.
- Changed: the daemon's own command line is what installs and starts its service during a repair, so the service entry is written by the thing that owns it rather than guessed at by this Agent. An absent daemon command is a normal answer — the offer simply is not made — and never a failure to start.
- Changed: commands this Agent runs resolve against the environment's current search path rather than a copy taken when the process started, so the daemon command an operator's setup actually names is the one that answers.
- **Fixed: post-wake capture ends when you stop talking, even in a room that is never silent** (platform runtime 2.0.12). The silence threshold was a fixed constant, and a fan or steady background noise above it kept the microphone open to the hard ceiling on every capture. The floor is now measured from the room's own ambient level just before the wake word, is exposed as a real setting (`voice.wake.silenceFloorRms`, 0 = adaptive), and `voice.wake.captureMaxSeconds: 0` now genuinely means no hard maximum — capture closes on silence, and whisper has no input limit.
- Changed: the bundled platform runtime is 2.0.12 and the daemon this Agent installs alongside itself is 1.28.14. Inside the exec boundary, the sandbox's self-description now names the built-in daemon and settings tools instead of leaving a model probing a loopback that is not the host's.

## 2.0.10 - 2026-08-06

- **Fixed: the screen comes up whole and goes back clean.** One frame was painted a few milliseconds before the Agent entered its own screen. That single early frame left a copy of the interface on the shell's screen — which is what reappeared, instead of your prompt, on quit — and it convinced the renderer that content was already on the fresh screen, so the first real paint skipped the header, the sidebar frame, and stray characters mid-word until something forced a repaint. The Agent now paints only while it owns the screen, from the moment it enters to the moment it gives the terminal back.
- **Fixed: an unnamed transcription or synthesis request goes to the voice provider the user configured** (platform runtime 2.0.11). The provider picker used to answer "use whatever is configured" with the first name on its internal list — a cloud provider — even when that provider had no key and this machine carried fully provisioned local engines. Wake-word transcription on a local-voice machine failed "OpenAI API key missing" while the working local whisper was never asked. Configured providers now win, local engines first: free, offline, no key. This covers both the daemon route and this Agent's own in-process fallback.
- Changed: the bundled platform runtime is 2.0.11 and the daemon this Agent installs alongside itself is 1.28.13.

## 2.0.9 - 2026-08-05

- **Fixed: a turn hosted by the daemon looks like a turn.** The thinking indicator and its 80ms waiting state ran only for turns this process answered itself, so a hosted turn showed a still screen from the moment you pressed Enter until the whole answer arrived at once. A hosted turn now drives the same waiting state, streams its text as it is written, names the tool it is running, and counts the tokens it actually spent.
- **Fixed: wake tells the truth about the microphone.** The device you pin is a hint — if it cannot be opened, capture moves to a device that can and says so instead of failing silently on a name that no longer exists. A recorder backend that keeps failing is rotated out rather than retried forever, listening is claimed only once audio frames actually arrive, and "there is no microphone on this machine" is reported as a different thing from "the microphone could not be checked".
- **Fixed: the Agent records why it died.** A crash left its stack on whichever terminal happened to be open and nothing anywhere else. Every process-level fault now writes a bounded record — message, stack, version, pid, and the session that was open — to `crashes.jsonl` under the Agent's own storage, flushes a line to the activity log before exiting, and prints the reason to the terminal's own output channel, which the full-screen display cannot swallow. A crash mid-write costs the torn last line and nothing before it.
- **Fixed: a conversation hosted by the daemon is a conversation you can come back to.** A hosted turn's transcript now lands in this Agent's session store when the turn ends, however it ends, and a surface that died mid-turn recovers the transcripts the daemon still holds on its next start. Settings reads resolve against the live daemon's own snapshot, so a value written on one surface reads back the same on this one.
- **Fixed: a new turn is no longer finished by the previous turn's ending.** This Agent opens a fresh event stream for each hosted turn, and a stream that claimed no position was handed the tail of the turn before it — that turn's ending included — which marked the new turn finished and threw away every frame of the answer actually being written. The stream now states the position it reached, so nothing already delivered is sent twice, and a turn-ending frame addressed to some other turn is refused rather than acted on. Heartbeats keep arriving for every other conversation while one of them is answering (platform runtime 2.0.10).
- **Added: only one Agent per home.** A second Agent started against a home a live one already holds now stops at startup and names the process id holding it, instead of two copies writing over one another's sessions and state. A dead or recycled holder is not a holder — an out-of-date record never blocks a start.
- **Added: the owner's terminal is untouchable on local turns too.** A command that drives an existing tmux session, window or pane this platform did not create — typing into it, killing it, resizing it, attaching to it — is refused with the rule named. Reading tmux state stays allowed, and the platform's own sessions stay fully drivable. The rule already covered turns the daemon hosts; it now covers turns this process runs itself, which is the path a fallback takes.
- Changed: the bundled platform runtime is 2.0.10 and the daemon this Agent installs alongside itself is 1.28.11.

## 2.0.8 - 2026-08-05

- **Fixed: every turn runs on the platform's host — including one-shot runs.** `goodvibes-agent run` now routes through the daemon like the interactive conversation, with the same output shapes and exit codes, falling back to this process with a stated reason on stderr when no host is reachable.
- **Fixed: a turn can no longer run forever.** A hosted event stream that closed cleanly never ended its turn — the interactive surface could show work that had already finished. Every stream ending now completes the turn.
- Changed: the bundled platform runtime is 2.0.9 and the daemon this Agent installs alongside itself is 1.28.11.

## 2.0.7 - 2026-08-05

- **Fixed: pasting an image works.** Ctrl+V with an image in the clipboard attaches it to your next message with a visible chip — the keystroke was silently discarded by a snapshot the shortcut route wrote back over the composer. Undo and redo were losing edits the same way and are fixed with it. When no clipboard reader exists, the reply names the package instead of doing nothing.
- **Fixed: the working area holds still.** The activity label named every streaming character of a tool call two at a time; it now names the tool and stays put.
- **Fixed: reminders respect being heard.** A reminder raises twice at most — at its lead time and on the day. Replying to one records the acknowledgment in the same turn and it goes quiet; your own remember-only dates never push at all; and a complaint about one reminder mutes that reminder, never the whole feature. Nudges arrive as framed notices, not bare lines woven into other conversation.
- **Fixed: voice setup finishes the job.** A dead runtime record no longer makes daemon-owned settings unreadable; wake transcription runs through the daemon first with a stated-reason fallback; enabling wake on a surface that is opted out says so and fixes it in the same act; and the managed installer repoints superseded manual paths by name and proves itself by speaking a sentence and transcribing it back.
- **Changed: setup completes what you meant.** Asks traverse the inferred chain — wake word implies speech-to-text as a one-line approval, forks like local-vs-BYOK text-to-speech are asked concretely — and no reply ever tells you to type a command. Pasting Google client values into the conversation registers them and answers with the consent link.
- Changed: exec output marks every truncation with a counted line, ordinary diagnostics are no longer refused by the command guard, and the sandbox states its own isolation.
- Changed: the bundled platform runtime is 2.0.9 and the daemon this Agent installs alongside itself is 1.28.11.

## 2.0.6 - 2026-08-05

- **Fixed: the platform can tell you what it knows about you again.** Profile reads failed against an up-to-date daemon because its answers carried more than its published contract allowed — the assistant asked where you live while your address was on file. The contract and the answers agree now, and a conformance test keeps them agreeing.
- **Added: what the assistant finds while answering you gets kept.** A flight itinerary found in your mail during an answer is proposed as a plan on the spot with every detail pre-filled and the source named — your one word files it. Recording what you tell it is part of answering, never an offer; a capture that cannot complete says so plainly.
- **Added: your conversations run on the platform's own host.** The agent's turns are hosted by the daemon by default (with a stated-reason local fallback), so your conversations are visible from every surface with their messages, not as empty rows. A settings split also fixes machines where one legacy flag silently disabled half the platform's connections.
- **Changed: connecting Google is one action.** Discovery picks the path before anything runs; one consent carries mail read, send, and calendar together; a signed-in gcloud CLI is a first-class source; a dead credential is diagnosed in plain words instead of retried; removing a stored credential asks you first; and a finished run proves itself by reading your mail and calendar live.
- **Fixed: browser automation cannot touch your browser.** Automated launches use the platform's own profile — never yours, never a window storm — one live session is reused, and sign-in pages are handed back to you as a URL to open yourself.
- **Fixed: search answers with what exists.** Method catalog search understands plain words ("google" finds the calendar, mail, and account methods), the settings catalog carries the connector keys the daemon really reads, unknown-tool errors name the tools that do exist, and the agent files its own sessions under its own name.
- Changed: a personal conversation never turns into editing the platform's own source code — diagnosing the platform is proposed in one sentence and waits for your yes.
- Changed: the bundled platform runtime is 2.0.8 and the daemon this Agent installs alongside itself is 1.28.10.

## 2.0.5 - 2026-08-02

- **Fixed: a chat message gets an answer, never workflow paperwork.** A conversational message — over Telegram or in the main conversation — could be turned into a full write-review-fix-confirm chain by a keyword heuristic that matched wording like "review the route" inside the transcript, and the reply sent back was the chain's status line ("passed (review 10/10); commit skipped: not a git repository"). The conversation gate's decision is now authoritative: conversation is answered, work is proposed and waits for agreement, and when a chain does legitimately run its reply carries what the agent actually found or did. Duplicate replies from the two completion reporters are gone (platform runtime 2.0.6).
- **Added: personal information shared in conversation gets captured.** A conversational channel turn previously ran with no tools at all — it could talk and do nothing. It now carries the profile capture tool with per-run owner authority: a trip itinerary pasted into chat lands in the owner profile's Plans section with its dates, flights, travelers and confirmation number, and the reply states concretely what was stored. Configurable via `profile.conversationalCapture` (default on) and `profile.ownerChannels` (defaults to the occasions nudge channel).
- **Fixed: a chat session is filed as a chat.** Channel-originated sessions are classified by their channel instead of as project sessions rooted in a filesystem path, and a sender on the channel's owner allowlist is attributed as the owner principal instead of unknown.
- **Changed: money settings hold the amount you would say out loud.** The payment budget keys drop their unit suffix and hold plain amounts in your currency, written exactly as you give them: `100` is a hundred dollars, `19.99` is nineteen ninety-nine, and `$100`, `100.00` and `100` all mean the same hundred — decimals allowed, never forced. Money detection is schema-typed (`unit: 'money'`), so the settings modal and search treat every money field correctly without name-sniffing.
- **Fixed: your settings file is rewritten only by its owner.** A newer client reading the daemon's settings migrates its in-memory view and leaves the file bytes untouched, so updating one product can no longer rewrite shared settings out from under an older running daemon; a migrated file names the reader that understands it, and an older reader refuses loudly instead of silently skipping your spending limits (platform runtime 2.0.6).
- Changed: the platform runtime is 2.0.7 and the daemon this Agent installs alongside itself is 1.28.9.

## 2.0.4 - 2026-08-02

- **Fixed: recording a fact about yourself lands in the right field.** The profile tool declared its field id as free text with two examples, so a model asked to save a name, an address and a spouse invented ids that do not exist (`full_name`, `home_address`, `wife`), had all of them refused, and fell back to writing the facts as prose notes. The tool now declares the platform's own field registry as the allowed values, grouped by section with the label each one writes, generated from the registry itself so it cannot drift. The tool also states which things are prose by design — people, places, work, standing notes, and dates — so a relationship or a birthday is no longer attempted as a field and then written twice.
- **Fixed: asking what this platform can do stops answering "nothing" when the answer is "quite a lot".** A question about payment cards and spending limits searched the settings catalog and got back zero results and a count saying zero settings exist, while the platform held 32 payment settings and a guided card flow. Three separate faults: the reported total was the size of the match rather than the size of the catalog, the one field that could have said "your query emptied this, not the platform" was skipped exactly when the page was empty, and matching required the whole query to appear as one contiguous run of text — so any phrase of more than one word failed, though its individual words matched dozens of keys.
- Changed: catalog searches understand plain words. A key is now searched as words rather than as a dotted identifier, alongside its description and a small vocabulary of the terms people actually use for a domain, and a phrase that matches nothing strictly falls back to its individual words — labelled as a looser match, offered as candidates, never auto-resolved as though it were exact.
- Changed: an empty search page says which catalog it searched and points at the others, and a page holding payment settings names the guided card flow, which no setting can carry out.
- Changed: the platform runtime is 2.0.4 and the daemon this Agent installs alongside itself is 1.28.6 — a corrupt watcher snapshot is quarantined with a receipt instead of crash-looping the daemon, and an unknown profile field id is refused with the valid ids named.

## 2.0.3 - 2026-08-01

- **Collapsed output is compact.** A folded block — tool result, thinking block, or compaction handoff — renders as exactly one row: its header, with the `▸ N lines` badge as the only count and the head of the content riding the same line (thinking folds keep their content behind the toggle by design). The frame rows, the interior preview row with its second hidden-count marker, and the blank rows between consecutive folded results are gone. Expanded rendering is unchanged. The fold decisions come from the shared platform policy the terminal app reads, so the two renderers cannot drift apart again.
- Fixed: connected-host calls dial the daemon where it answers. Every client-side URL built from the configured host now maps a wildcard bind (`0.0.0.0`, `::`) to loopback before dialing — thirteen call sites route through one shared helper, and `goodvibes-agent doctor` reports the loopback form. Pairing and QR URLs are deliberately excluded: they are read by another device, where the right answer is this machine's LAN address. With the platform runtime at 2.0.3 the transport also stops refusing wildcard hosts as "public", so profile reads and writes work over a deliberately LAN-bound daemon.
- Fixed: `/collapse thinking` folds the reasoning block. The collapse state was registered but nothing read it, so the command silently did nothing.

## 2.0.2 - 2026-08-01

- **Fixed: conversation turns work again.** The 2.0.0-2.0.1 packaged runtime crashed on the first message of every conversation — the platform runtime still carried pre-split remnants that lazily imported in-process daemon composition code, which fractured the packaged bundle's module initialization; the turn engine then hit an uninitialized module and died with a swallowed error, leaving the session frozen at "awaiting response". The runtime is now 2.0.2, which removes those remnants entirely, and this release's gates run a real prompt through the built bundle before anything ships.
- Changed: the runtime barrel's operations exports are live re-exports from the platform runtime instead of eagerly-evaluated aliases — the same initialization-order hazard class, removed at the source.

## 2.0.1 - 2026-08-01

- Fixed: importing settings that include `display.themeMode` no longer prints an "unknown key" warning. The key is now declared in the platform configuration schema (SDK 2.0.1) — `auto` probes the terminal background once at startup, `dark` and `light` force a fixed appearance — so the settings screen and the import path both treat it as a real, documented setting.

## 2.0.0 - 2026-08-01

- **BREAKING**: this build declares a daemon build floor of 1.28.0, and a daemon below it is REFUSED, not merely flagged. The daemon is its own product, with its own repository, package and release line, separate from the embedded topology this Agent shipped and updated alongside itself before that split, and a daemon build below 1.28.0 belongs to that earlier topology — it answers some of the verbs this build depends on and not others, so adopting it produces a half-working Agent where one call returns 404 and reads as a broken feature rather than as an old daemon. On each adoption attempt this Agent reads the daemon's own build off `/status`; below the floor it does not adopt the daemon at all. Concretely, that means the memory spine keeps using its local store instead of routing over the wire, the inbound continuation dispatch never binds, and every daemon-dependent path behaves exactly as it does when no daemon is configured. The first time a below-floor daemon is observed, one system message names both versions: "[Connected host] The daemon at <address> is running build <version>; this client requires 1.28.0 or newer — update the daemon." The daemon updates itself automatically, on its own hourly cycle and at the next idle restart, so the ordinary path needs no action; if it has not updated on its own, update the owning GoodVibes host directly, then restart it. No restart of the Agent is needed once the daemon is current — the floor is re-checked on the next adoption attempt and the daemon is adopted then.
- Changed: the daemon/TUI product split, from this Agent's side. The Agent no longer composes any daemon-grade service — it is a pure client of the standalone daemon. The in-process pairing-token manager is gone entirely: minting, checking and revoking a per-device token was never something this process listened for a connection to do, and a paired phone now reaches this Agent's device tools through the daemon's own verbs (`devicesClient`) instead. An approval ask is no longer answered by a broker only this process could see — it is raised on the daemon, with this process as one possible answerer (first real answer wins), and the on-screen card and approvals panel render the daemon's record unioned with whatever the local broker still legitimately holds rather than treating the local copy as the whole list. A setting or credential written from the settings modal now goes to the daemon over `config.set` and `credentials.set`/`delete` — previously it landed in this process's own store and reported success while the parts of the platform with no window open, scheduled work and inbound channel handling among them, read a different value or nothing at all. The one thing that stays local by design is the session register the automation engine schedules and dispatches its own jobs against: a surface that runs its own loop and reaches a daemon for everything else still needs a place to track the runs it starts itself, and that register dispatches nothing — inbound continuations arrive over the daemon's `sessions.inputs.list` instead.
- Added: the Agent can now join, steer, and watch a conversation the daemon is hosting, not only ones running in this process. `sessions.steer` resolves a hosted session's id exactly as it resolves a local one, and the approvals panel subscribes to asks the daemon raises for a hosted run instead of polling for them. With `hostedSessions.promoteInboundConversations` turned on, the first message of an inbound channel conversation creates a daemon-hosted session titled from the sender's own words, and every later message in that conversation is steered into it rather than answered fresh each time; the setting ships off, and off costs nothing — the continuation runner does not spend a round trip finding that out. A daemon that cannot be resolved, a workspace root that is not absolute, a host at its session cap, or a hosted session that was killed or lost to a restart all fall back to answering the message here instead of losing it, with the reason logged rather than surfaced as a failure.
- Changed: the unified inbox now reads the daemon's own inbound feed (`channels.inbox.list`), folding provider messages — Slack DMs, email threads, and the rest — into the same item list as deliveries, surface messages and route bindings, with the sender shown exactly as the daemon reports it rather than digested the way a route binding's external id is. When there is no feed, the stated reason is what was actually observed — the daemon refused the method, was unreachable, or the token was missing — replacing a blanket "not published" message that was wrong on a method the contract already served and pointed whoever read it at fixing the wrong thing. Composed channel drafts and channel-to-profile routing assignments now sync to the daemon's own stores (`channels.drafts.*` and `channels.routing.assign`) instead of staying only in a local file: a draft or assignment made while the daemon is unreachable is still kept locally, marked pending with the reason the daemon gave, and offered again later, with a receipt recording what happened to it either way — a refused sync is receipted as refused rather than dropped silently.
- Changed: the activity sidebar's Now section, and `/tasks`, now show work the daemon is running that this process did not start — scheduled jobs, hosted sessions, anything submitted from another surface — unioned with the agents and tasks this process is running itself and labeled as running elsewhere. Local rows always win on a shared id, because the local copy is live and the polled one is not, and a daemon that cannot answer keeps the last rows it gave rather than emptying the view. `/tasks` still refuses every lifecycle mutation here, cancel and retry included, by this product's own policy — the union only widens what is visible, not what this surface can act on.
- Fixed: a rewind point could previously only reach a turn from the current run. The mapping between a conversation turn and its files-checkpoint boundary lived in memory only, so resuming a session and then trying to rewind past the resume found nothing — the same turn ids that worked a moment before the restart were gone after it. Turn anchors are now persisted to a sidecar beside the session's own transcript file and reloaded on `/session resume`, which reports how many rewind points came back. A bounded housekeeping sweep runs at startup and then on a cadence to reclaim sidecars whose session is gone or whose content restores nothing, and it discloses what it removed rather than deleting quietly; the session currently in use is never a sweep target.
- Changed: no Google or Microsoft OAuth client id ships with this product anymore. Connecting a calendar now requires the operator to register their own app with the provider and set the client id under the key the connect flow names (`calendar.google.clientId` or the Microsoft equivalent); until that key is set, `/calendar connect` and the workspace card both refuse with a message naming the exact key to set rather than reporting a generic setup gap. The client id this build shipped before today was already an inert placeholder that could never complete a real OAuth exchange without an operator override, so no calendar connection that previously worked stops working — the change is that the refusal now says plainly whose app is missing instead of describing a bundled default that was never real.
- Changed: the `daemon.embedInProcess` setting is gone — this Agent never spawned or embedded a daemon of its own, it only ever adopts one already running, so a setting offering an in-process daemon described a mode this product does not have. `daemon.enabled` is unaffected and keeps its real meaning: whether this Agent looks for a daemon to adopt at all. Anyone who had `embedInProcess` set sees a one-time settings-migration note through the same connected-host receipt channel that already reports a daemon update or a crash-restart, naming what happened to the setting.
- Changed: the bundled GoodVibes platform runtime is 2.0.0.

## 1.23.1 - 2026-07-30

- Fixed: a startup failure could kill the Agent without saying anything. Once the terminal is set up for the interactive screen, the Agent replaces the ordinary output streams so that stray text cannot corrupt what you are looking at — an intercepted line goes to the activity log instead of the terminal. The startup error report was written through exactly those replaced streams, so a failure raised after that point had its explanation swallowed and the program exited with nothing on screen, nothing in the terminal's scrollback, and nothing a service log would pick up. Measured on a compiled binary: exit code 1, zero bytes of output, twice over. Every startup exit — the failure report, the refusal to run without a real terminal, argument and settings errors, and `--help`, `--version`, `completion` and `status` — now writes straight to the terminal's own output channel, which nothing can intercept and which has finished writing before the program stops. A test compiles the real binary and counts the bytes, because the same code run from source was always loud and no source-level test could have caught this.
- Changed: the conversation-first continuation gate and the daemon client-build-compatibility check now consume the platform runtime's own modules directly instead of a local copy kept here while those modules were not yet public.
- Changed: the bundled GoodVibes platform runtime is 1.21.0.

## 1.23.0 - 2026-07-30

- Added: the Agent now raises the dates that matter — birthdays, anniversaries, and the rest of what you have told it to remember — in conversation, before they arrive, on the lead window and quiet hours you set. A reminder names the occasion and the person and never the date itself; "in ten days" is the platform's own day count turned into a word, not something computed here. A gift-giving date opens a short interview — one question at a time, resuming where you left off if you step away — while a remember-only date does not ask anything, because only you know whether an offer to help buy something is welcome. You can say yes, no, or later to any of it, and a date you happen to mention in passing gets confirmed once, right when you can still correct a mishearing. This is conversation-only, the same as before: never the terminal UI.
- Added: wake-word listening on this surface. Say the wake word, get an activation sound and a persistent listening indicator, and what you say next is transcribed straight into the conversation input — or submitted outright if you have that turned on. Either enablement setting being off means no microphone is opened at all. The capture pipeline, the framing math, and the supervisor that restarts a dropped listener all come from the platform runtime; what stays local is starting the recorder process, the on-device speech model, the chime, and the footer row.
- Fixed: three settings that looked switchable but were not — route binding, delivery tracking, and a handful of others behind watchers, automation, token auditing, and hands-in-the-loop mode. Each one rendered in the settings screen, took a write, and reported success, while the underlying manager kept running exactly as before regardless of the value. All of them now genuinely turn off when you turn them off.
- Fixed: continuity data (recovery-file checks among it) was being read from the wrong directory pair, one this product has never written to, so a check could answer confidently about a location that was never in play. It now reads from this product's own declared storage root.
- Changed: device posture — the settings-to-policy mapping and the confirmation flow behind the `phone` tool — now comes from the platform runtime instead of a private copy kept here, so a change made while the Agent is running takes effect on the next request instead of waiting for a restart.
- Changed: the bundled GoodVibes platform runtime is 1.20.0.

## 1.22.1 - 2026-07-29

- Fixed: a correctly configured inbound surface returned 401 on every message sent to it.
- Fixed: a webhook POST carrying the right secret was rejected as unauthorized, on a surface whose settings showed it connected and whose secret was exactly what the sender was using. The platform runtime bundled with 1.22.0 had started moving surface credentials into the secret store and leaving a `goodvibes://secrets/...` reference in settings, and twelve channel adapters compared that reference character for character against what the caller presented. The two are never equal, so the check could only fail. Telegram in webhook mode was the worst case — the daemon registers the webhook with the resolved secret, so Telegram sends the real value and the adapter rejected it against the reference — while Telegram in polling mode was unaffected, which is how a surface could look healthy while nothing arrived. Every such check now resolves the credential first and answers 503 rather than 401 when it is configured but unreadable: nothing is wrong with the caller, and a 401 invites someone to change a secret that was correct. Nothing you turned off or rotated while chasing this needed changing.
- Changed: the bundled GoodVibes platform runtime is 1.19.2, which carries that fix.
- Changed: the release-notes gate now fails when the shipped notes describe a different release than the one being cut. `release/release-notes.md` travels inside the published package, and it had gone seven releases without being rewritten — the notes for 1.15.0, describing the phone tool and triggers, were still what a reader opened as late as 1.21.0. The gate only counted bullet points and banned marketing words, and stale notes pass both.

## 1.22.0 - 2026-07-29

- Your profile and your payment details are now things you enter and correct at the terminal, and outward actions ask you before they act on anything a stranger wrote.
- Added `/owner-profile`: read what the Agent knows about you, show one field, look one person up by name, trace where a fact came from, correct one, or forget one. A line is named by its content, never by its position, so editing the file while a correction is in flight cannot delete the wrong line. The same profile is on the workspace screen you actually look at, and the Agent can reach it mid-turn through its own tool rather than guessing from what it has been told this session.
- Added `/payments`: enter the payment card — number, expiry, CVV, cardholder name, each typed masked — and the billing and shipping addresses the daemon uses for purchases. Card material is never rendered back and never lands in a config file; it is written to the daemon's secret store, which is the process that completes an unattended purchase with every window closed. Budgets, delivery tier, approval and veto windows and the CVV trade-off live in Settings > Payments, where a money field is typed in ordinary units ("19.99") and stored exactly, with no rounding drift.
- Added: an action that reaches outside this machine — sending mail, posting to a channel, touching a linked account — now asks you first when what it is about to send derives from content someone else wrote. A page you asked it to read, a message that arrived, a document, and now a subscribed calendar feed all carry that mark, and it follows the content through to the moment of sending rather than being checked once at the door. Your own words never trigger it: mail you asked for goes out without a prompt.
- Added: startup says when something on your PATH shadows a program the Agent expects to run, and when a service it needs is not reachable, instead of failing later with an error about something else.
- Changed: a credential typed into settings is filed where the daemon can read it. It used to land in this program's own store, so scheduled work and inbound messages — which run with no terminal open — found nothing and reported the integration as unavailable while the settings screen showed it configured.
- Changed: card material is redacted in a support bundle by declaration rather than by guessing from the end of a key's name. The previous rule matched words like "token" and "password" and would have carried a card number in the clear, because none of the four card fields ends in a word that list knows.
- Changed: asked what it can do — reach Gmail, a calendar, a browser — the Agent answers from its own live runtime, and says which build is answering. It used to be able to answer from a search over the source tree, which describes a repository rather than the program you are talking to.
- Fixed: a settings listing that had been cut off said nothing about it. The catalog stopped at a fixed 500 entries while the schema had grown past that, so a real setting past the cut read as a setting that does not exist. The ceiling is now well clear of the catalog, and every listing that returns fewer than matched says so and says how to ask for the rest.
- Changed: the bundled GoodVibes platform runtime is 1.19.1, which carries the calendar-ingest, payments and owner-approval support behind these notes.

## 1.21.0 - 2026-07-27

- Mail, calendar and browser control now come from the bundled GoodVibes platform runtime instead of a second copy carried here.
- Changed: the Gmail and Calendar connector, the mail service and the browser engine were implemented inside this product, which is why the background daemon — the part with no window attached — could not read a mailbox, answer a calendar request or open a page on its own. Scheduled work, triggers and inbound channel messages had no way to do any of it. All three now live in the platform runtime and the Agent consumes them. About 9,700 lines of duplicated implementation are gone, and no duplicate of a moved symbol remains here.
- Changed: what stayed behind is what only this product can answer, each supplied in exactly one place — which surface a page is labelled with and which tool a refusal names; the single browser composition point (storage root, untrusted-content port, host-script advice, session write ledger) that the browser tool, the browser command and the Google setup flow all build through; the driver release asset names, install kinds and reinstall commands; the mail transport and this product's own sender-claim wording at both construction sites; and the account registry's store path under the agent surface root.
- Changed: the rule about untrusted content — the standing rule text, the ledger, the origin reader and the outward-effect decision — is taken from the platform rather than defined here. Defining it here was right while the Agent was the only runtime that could both read a page and send a message; it is not any more, and a scheduled job that reads a page and then mails someone is exactly the composition the rule exists for. A second copy of the refusal wording inside the daemon would have drifted within a release, and a boundary that says one thing in the Agent and another in the daemon is not one boundary. Every name keeps its meaning and its signature, so no caller changed.
- Changed: the browser driver is no longer declared as a dependency of this repository — it arrives with the platform runtime, whose browser engine loads it — and the lockfile no longer resolves it as a direct one either. Declaring it in one file and resolving it in the other would have let a fresh install reproduce the old graph and prove nothing. The build still stages the driver beside the compiled binary.
- Fixed: the verification ledger's settings percentage was measured against every configuration key the platform declares anywhere, so keys belonging to other products lowered this product's reported coverage without anything here having changed — 25 keys for the daemon's own mailbox and calendar took it from 70.7% to 69.1% while the numerator never moved. It now counts the configuration keys this repository actually references, 292 of 494, and the whole-ledger figure is 84.5%. The floor moves to 84, just under the measured value and never above it: a floor thirteen points below reality is not a ratchet, it is thirteen points of room for the silent decay the fix exists to stop.


## 1.20.0 - 2026-07-27

- Google connection setup, browser control that works in a binary install, and an auto-update switch that means what it says.
- Added: the Google connection routes are now offered as cards in the workspace under Personal Ops — connection status, the app-password path, the guided browser walkthrough, adopting credentials that already exist on this machine, loading a downloaded client JSON file, and pasting a client id and secret. The workspace cards and the `/google` command run the same action layer, so the two cannot drift, and a test reads the command's own list of routes and fails if any route has no card.
- Added: a workspace action result that is longer than the pane now scrolls with PageUp and PageDown instead of ending where the pane does, and a result that is still cut off says how many lines it could not show.
- Fixed: a browser could never be installed from a compiled binary. The installer looked for `bun` or `node` on PATH to run the driver, and a compiled binary has neither, so every attempt failed before it started. It now runs the driver's own command line directly. A missing interpreter is also no longer recorded as a failed install: the message for a program that is not on PATH is not the one the code was matching, so an install that never ran was reported as an install that broke.
- Fixed: `browser status` is documented as read-only and was downloading a browser driver into your home directory the first time you asked it what the status was. It now only reports.
- Fixed: a partial driver directory was accepted by the capability probe and then rejected by the loader, so browser control reported itself ready and failed on first use.
- Fixed: turning auto-update off only stopped the update at launch. The while-running updater replaced the binary anyway on its own schedule, so `update.autoUpdateAtLaunch: false` did not stop the program from replacing itself. The switch now covers both paths, an explicitly set `update.auto` still wins over it, and every swap appends a receipt beside the binary so a replacement is never silent.

## 1.19.0 - 2026-07-27

- Google, browser control, and an honest capability index.
- Google setup is wired and reachable. google-setup-flow referenced a step-runner module that was never written, so the console walkthrough, client intake, app-password flow and client download had no importer outside their own tests — the build was correct to report email and calendar as unwired. The binding layer now exists, /google covers status, adopt, setup, client-file, client, account, calendar-address and runbook, and /email and /calendar are no longer hidden.
- The mail and calendar capabilities are declared against a route that is actually served. They previously pointed at daemon operator methods the contract ships as invokable: false, so no amount of configuring a mailbox or adopting credentials could change the answer. They now resolve through an in-process Google tool backed by the connector, with prerequisites that read the credential sources the connector really uses.
- Browser control works in a binary install. The capability probe resolved the driver with createRequire(...).resolve(), which can never succeed inside a compiled executable, so browser control reported needs-setup on every binary install even when the driver was present — and the self-provision path was never reached. The probe now checks the real load paths, the driver ships and refreshes with the binary, provisioning needs no package manager, and a partial driver directory no longer shadows a working one.
- Accounts the agent creates are recorded and revocable. The prohibition on creating them was never a rule anyone made; visibility replaces it, through an accounts tool that records service, URL, alias, purpose and secret-store key.
- Remediation text no longer points at MCP servers or a setup-google command that does not exist.

## 1.18.1 - 2026-07-27

- Fixed: agent runs the Agent was hosting are now cancelled when it shuts down. One left running had nowhere to report to — the registries and event bus it reports through are already gone by then — while keeping an in-flight provider call alive and sleeping out a retry it had no reason to finish.
- Fixed: the home-graph knowledge service is now stopped through the same list as every other background worker, rather than by a separate registration the contract could not see.

## 1.18.0 - 2026-07-27

- Added: the Agent can drive a real web browser — open pages, read them, click, type, fill forms, sign in, and take screenshots — with a saved profile that keeps logins between runs. Page text it reads is labelled as untrusted: it can inform an answer, and it is never treated as an instruction.
- Added: a setup walkthrough that connects Gmail and Calendar without a console marathon. It drives Google's own pages for the parts that cannot be automated any other way, and stores the credentials where the daemon can reach them.
- Added: `mcp mode:"call"` — the Agent can now call tools on a connected MCP server, not just list them.
- Added: one honest index of what this Agent can do. Where a capability is not available yet it names the specific missing piece rather than denying the capability exists, and it notices when credentials are present but the capability is silent.
- Added: an email's displayed sender now carries how much that claim can be trusted — whether the sending domain actually authenticated — instead of being shown as though it were established fact.
- Fixed: a search of the channel catalog that matched nothing read as "this install has no channels", and was reported to a user as "email is not configured". A short or empty list now says what it is and how to see everything.
- Fixed: a mailbox password set from here was accepted, reported as saved, and written nowhere — it was gone on the next start.
- Fixed: an Agent told to stop now stops what it started, including the browsers it opened.
- Fixed: a screenshot the Agent took could not then be opened by the Agent, because the read guard refused the folder it was saved in.
- Fixed: a long-running Agent no longer goes stale between restarts; it checks for updates on its own schedule.
- Fixed: the transcript's status markers sit in the assistant's own column and the tree's rails close properly.

## 1.17.0 - 2026-07-26

- Fixed: a work request sent over a chat channel produced a proposal that could never be shown. Agreement was asked for on a channel there was no way to send on, so nothing arrived and the work waited on an answer to a question that was never posed. Proposals now go out on every channel the gate covers, Telegram included.
- Fixed: an inbound message that landed in an already-running session started work immediately no matter how the conversation gate was configured. The gate's settings now reach the process that receives the message.
- Fixed: every log line the background host produced was discarded, so a rejected token, a channel that could not start, and a reply with nowhere to go all left no trace. The activity log now has a destination before anything else starts.
- Fixed: a channel that was switched on but could not start said nothing. It now reports which channel, why, and what would fix it.
- Fixed: conversation-gate settings were written to whichever client edited them, where the background host never reads them, so they changed nothing. They now live with that host and existing values are moved there on first start.

## 1.16.0 - 2026-07-26

- A paired phone is now something Agent can use. Its cameras, screen, location, clipboard, and small device actions (show a notification, open a link, buzz) are available through a native `phone` tool rather than an add-on, so a picture, a screen, or a location can be part of the work you asked for.
- Nothing is taken from a phone quietly. Every capture and every action asks the person holding it first. Choosing "always allow" is offered on every capability and records one standing permission for that one capability on that one phone, listed and revocable wherever you manage the phone, and taking effect the moment you revoke it. Captures are kept 24 hours and then deleted.
- Added triggers: watch something, and act when it changes. Watch a long-running command and run follow-up work when it finishes, with its exit status and output tail carried into that work. Watch a running command's output as it is produced and act on the first line that matches. Or run a cheap check on a schedule with no model involved and start work only when the answer actually changes, rather than on every poll. Triggers ship off, and nothing watches anything until you turn them on.
- Wake-word detection has platform support, and says plainly that it does not run yet. The detector, its audio front end, and the published "hey goodvibes" model are all in place, but no surface captures microphone audio yet, so turning the setting on does nothing in this build and the setting itself says so. Your choice is remembered for the release that adds capture, and the feature reports itself unavailable rather than appearing to listen.
- Fixed: a conversation that had already written to you could get no reply at all. Every channel built its list of places to answer only from optional settings — a default chat id, a bot username, and their equivalents — so when those were left blank there was nowhere to send the answer, even for a conversation that had just messaged you. Replies now go back to the conversation the message came from with no configuration at all, on all fourteen channels. The optional settings keep their real job: starting a conversation somewhere nobody has written from.
- Fixed: asking a background process what it has printed now answers while it is still running, instead of returning nothing until it finishes.
- Added a build floor between this app and the daemon. A daemon update swaps the daemon and leaves running apps on the build they started with, so a fix could land, be verified installed, and still not change what you see. This build now checks the minimum build the daemon will let take part, and when it is below that floor it says so and stops taking shared work rather than quietly continuing under superseded rules.
- The push notification settings the platform runtime gained are reachable under Notifications — the contact address a push service uses to reach you about a delivery problem, and the bounds on how registered devices are kept tidy. They sit with the settings that already decide which events get pushed.
- Updated the bundled GoodVibes platform runtime to 1.15.0, which carries the triggers, paired-phone, wake-word platform, reply-routing and background-output changes behind these notes.

## 1.15.0 - 2026-07-25

- v1.15.0 changes what a message means. A message arriving from a connected channel now gets a conversational answer instead of quietly turning into a full workstream with a reviewer, quality gates, and a second agent. When Agent judges that what you asked for warrants real work, it proposes that work and waits for you to agree.
- You confirm on whatever channel the proposal reached you on, so a proposal made over one channel is accepted over that same channel rather than sending you somewhere else to answer.
- Work you already authorized is unaffected and never asks twice. Schedules, triggers, on-exit chains, and a proposal you just agreed to were all authorized when they were set up, and they still run on their own.
- The terminal app is unchanged. You are sitting in front of it and typed the thing, so work starting is the expected outcome there.
- Fixed: progress notifications now send only what is new instead of resending the whole accumulated log each time, and an identical repeated message is suppressed rather than delivered twice.
- Fixed: a single incoming message can no longer start two agents. The same message could previously arrive over two different routes and run the whole pipeline on each one.
- Fixed: links in notifications now point at an address another device can actually reach. When the control plane is set to listen on every interface, the link could carry a listen-only address that went nowhere when tapped on a phone. If no reachable address exists, the link is left out rather than shipped broken.
- Updated the bundled GoodVibes platform runtime to 1.14.0, which carries the conversation-first gate, the notification delivery fixes, and the duplicate-message protection behind these changes.

## 1.14.0 - 2026-07-25

- Fixed: the reasoning effort level you choose is no longer lowered permanently by one model. Your configured level is kept as you set it, the runtime uses whatever the current model can actually deliver, and switching back to a capable model restores your level. The display shows both values and says when a model is the reason your level is capped.
- Fixed: the notice explaining that a failover snapped your reasoning level down was being deleted from the transcript by the retry path on every failover, so nobody ever saw it. The notice now stays.
- Fixed: markdown tables no longer silently drop trailing columns — including headers — when the terminal is too narrow for the column count. A table that cannot fit is now stacked as "Header: value" records so every column is still readable.
- Fixed: config file changes are no longer silently lost when the write lands while the settings watcher is still starting up.
- Fixed: saved state now gets real housekeeping when it is recovered — stale entries are reaped, growth is bounded, contents are checked rather than assumed from the file merely existing, and anything removed is disclosed instead of vanishing. An interrupted migration no longer strands your older sessions out of reach.
- Fixed: published packages no longer silently omit bundled agent and skill content.
- Updated: bundled GoodVibes platform runtime to 1.13.1, which adds Telegram inbound messaging (polling with a saved cursor or webhook, and /start, /help and /stop handled as commands) and the per-model reasoning effort model behind these changes. Telegram bot tokens now resolve secret references instead of sending the reference text to the API.

## 1.13.1 - 2026-07-24

Recovery reliability release.

Crash-recovery prompts no longer appear for snapshots that a still-running session is actively maintaining — including sessions running an older build. Consume and remove act on exactly the snapshot that was offered, wherever it lives. Ships against the updated bundled GoodVibes platform runtime.

## 1.13.1 - 2026-07-24

Storage identity and recovery honesty release.

The Agent now declares its storage surface once and derives every session, pointer, recovery, and checkpoint path from that single declaration, backed by the bundled GoodVibes platform runtime's new declare-once storage surfaces. Workspace checkpoints move to the Agent's own scoped store via a one-time migration, ending shared-store races with other products in the same working directory.

Sessions you explicitly save (or fork, or rename) are now marked as user-saved and never expire from retention sweeps. Resuming or forking a session updates the last-session pointer immediately, so a resume followed by a quit no longer points the next launch at the wrong session.

Crash-recovery prompts act on exactly the snapshot they describe: Ctrl+R restores and retires that snapshot, Esc removes that snapshot, and exiting retires only the exiting session's snapshot. The README is rewritten around a short verified tour.

## 1.12.5 - 2026-07-18

### Changes

Fixed: the encrypted secrets store can no longer be silently orphaned by key changes — key generation is race-safe, writes refuse a stale cached key (and restore a missing keyfile), and a mismatched store now reports exactly which key wrote it.
Updated: the bundled GoodVibes platform runtime to 1.11.4.


## 1.12.4 - 2026-07-17

### Changes

Fixed: selecting a custom-provider model no longer crashes the app at the next startup — boot now waits for custom providers to load before resolving the current model, and falls back to a selectable model (with a logged warning) if the configured provider's file was removed.
Fixed: after an automatic context compaction, the transcript shows a compact expandable "compaction handoff" block instead of re-printing the entire re-injected instruction text every time.
Updated: the bundled GoodVibes platform runtime to 1.11.3 (quieter startup when no hooks file exists; error summaries no longer mangle redacted paths; npm tarball publishes are path-safe).


## 1.12.3 - 2026-07-17

- Republishes the Agent with its packaged runtime intact: 1.12.2's npm tarball was missing the bundled runtime because the rewired publish lane packed from a bare checkout; the lane now publishes the pack job's tarball (runtime bundled and now asserted present inside the tarball before staging), and the registry install smoke that caught the defect is unchanged. 1.12.3 supersedes 1.12.2, whose tarball was published without the packaged runtime.
- Adopted the published platform SDK 1.11.2, which now carries the shared release toolchain as a dependency.
- Zero-touch releases: a green CI run on a release commit tags and dispatches the release automatically; no manual step between landing the commit and the published release.

## 1.12.2 - 2026-07-16

- Adopted the published platform SDK 1.11.1 from the registry.
- Release engineering moved onto the platform's shared CI/CD system: pushes are validated once by CI, and a release verifies that exact run's per-job results instead of re-running gates, so tagged releases cut over in minutes with the same guarantees.
- Release binaries are built by the shared build matrix and published with npm provenance through the shared publish workflow; the GitHub release asset set (four binaries, four sqlite-vec addon archives, npm tarball, SHA256SUMS) is unchanged.
- No change to conversations, memory, skills, routines, personas, or confirmation gates; this is a dependency-refresh and release-engineering release.

## 1.12.1 - 2026-07-16

- SDK 1.10.1 adoption
- Cleaner runtime typing via the SDK public RuntimeServices type alias
- Test suite no longer exercises host power integrations

## 1.12.0 - 2026-07-16

- Memory governor is composed and started by default, with live memory diagnostics surfaced in /health.
- One-act local voice setup with live install progress.
- docs and README release-line auto-sync via the prebuild step.

## 1.11.0 - 2026-07-14

- GoodVibes Agent 1.11.0 runs on the current published platform SDK 1.9.0, picking up the latest shared runtime, review, and power-management primitives.
- Keep-awake and idle-inhibition now hold a real OS-level inhibitor explicitly: the Agent process owns the host sleep edge while it runs, so the always-visible power chip and the keep-awake toggle reflect a genuine hold rather than a no-op. This posture is pinned by a composition test so it cannot silently degrade in a future dependency update.
- When an external GoodVibes daemon is adopted, the keep-awake toggle still forwards to that daemon over its operator route so the hold survives this Agent closing; that path is unchanged.
- No change to your conversations, memory, skills, routines, personas, or operator confirmation gates; this is a dependency-refresh and sleep-ownership hardening release.

## 1.10.0 - 2026-07-13

- Agent updates itself at launch: the standalone binary lands on the newest release at startup, keeps a rollback binary, and /update is a first-class Agent command.
- Model picker re-checks live model discovery when opened, so newly available models appear without a restart.
- At boot the Agent starts a connected host that is installed on this machine but stopped: one start through the platform service manager, a bounded wait for it to answer, and an honest receipt.
- Connected-host honesty receipts reach the agent surfaces through an explicit once-per-attach read, and fleet views gain per-node headlines with a quiet-stall marker.
- Checkpoints are gated on explicit workspace eligibility using the typed origin and checkpoint-eligibility registration fields, not mere shared-store registration.
- Feature availability is settings-derived with a default-on posture across the CLI, onboarding, and the settings workspace.
- Adopted the published platform SDK 1.8.0 from the registry: the public store-snapshot scheduler and exec prompt wiring, the shared model-reference resolver for shared-session spawn routing, and the SDK public announcement and loopback-approval modules replacing vendored mirrors.

## 1.9.1 - 2026-07-11

- Every GitHub release now attaches the sqlite-vec native extension as a per-platform archive (`sqlite-vec-<os>-<arch>.tar.gz`) next to the compiled binaries, so a directly-downloaded standalone binary can restore the semantic memory vector index by co-locating the addon. The npm/Bun package channel is unchanged.
- Each addon archive carries the exact `lib/sqlite-vec-<os>-<arch>/vec0.<suffix>` layout the runtime resolves, so it extracts in place next to the binary with no renaming, and all four archives are checksummed in `SHA256SUMS.txt` under the same missing-entry-fatal rule as the platform binaries.
- The release build fetches each target platform's sqlite-vec addon from the npm registry during cross-target builds, so every platform's addon ships regardless of which host built the binaries.
- README and the release docs describe how to place the addon next to a downloaded binary and confirm it with `goodvibes-agent memory vector status`, which reports `available: yes` once the addon is co-located.
- On macOS the system SQLite refuses to load extensions, so the darwin addon archives ship for parity but the vector index stays unavailable there and memory search falls back to literal matching; this is a platform limitation, not a packaging defect.

## 1.9.0 - 2026-07-11

- GoodVibes Agent now publishes self-contained compiled binaries for Linux and macOS (x64 and arm64) on every GitHub release, each verified against a SHA256SUMS manifest, so the public installer can set the agent up as a single binary with no separate Bun runtime step. The npm/Bun package channel is unchanged.
- Standalone binaries resolve plugins, hooks, and configuration from your filesystem exactly as the Bun runtime does; the semantic vector memory index additionally needs its native extension co-located with the binary and otherwise falls back to literal memory matching, reported plainly by the memory vector status command.

## 1.8.2 - 2026-07-11

- Adopts platform SDK 1.7.1.
- Exposes 20 previously SDK-only settings in the settings modal: adaptive notification-burst suppression, fetch-tool response sanitization and trusted/blocked host defaults, credential rotation-audit policy, integration delivery retry/backoff/dead-letter behavior, policy-as-code bundle loading, and per-turn passive knowledge/code injection and context-compaction tuning.

## 1.8.1 - 2026-07-09

- Fixes every ws-only control-plane verb (fleet, checkpoints, session search, push) answering 501 'Gateway method is not invokable' on the vendored daemon — handlers are now attached at runtime construction, with a release gate that invokes them end-to-end.

## 1.8.0 - 2026-07-09

- Adopts platform SDK 1.6.1.
- When a provider rejects a request as exceeding the model's context window, the agent now compacts immediately and retries once — and learns that endpoint's real context ceiling so future window math, compaction thresholds, and meters stop trusting over-stated catalog values.
- Agent-completion notices are delivered to the conversation exactly once; they no longer repeat with escalating urgency tags turns after the agent finished.
- Finished agent/swarm process subtrees can be archived out of the live fleet view into a session archive (and restored), on this machine and over the wire for remote surfaces.
- Release live verification: a doctor exit whose only findings are operator-configuration risk advisories no longer fails the strict gate; real errors still do.

## 1.7.0 - 2026-07-08

- Adopts platform SDK 1.5.0.
- When the model itself reports that its context window filled up while
- producing a response, the agent now compacts its conversation immediately —
- before the next model call — instead of waiting for local token estimates
- to cross a threshold. The model's own report is treated as authoritative.
- Custom per-model context windows configured on this machine now apply to
- agent runs too, and persist across restarts.

## 1.6.4 - 2026-07-07

- The exec tool no longer denies destructive- or escalation-class commands (kill, docker, sudo) that the permission configuration allows — class-level risk is decided by permission settings alone. The only remaining unconditional block is a small frozen catastrophic list (root filesystem deletion, raw disk destruction, fork bombs).

## 1.6.3 - 2026-07-07

- SDK 1.4.0 pin: the shared daemon contracts gain server-side companion-chat turn control — a true stop verb (provider stream aborted, honest partial persisted), queue-when-busy sends, and steer (interrupt-and-send-now). No agent-side behavior changes; agent session turns already had lifecycle control on the operator wire.

## 1.6.2 - 2026-07-07

- Updated to SDK 1.3.3: the macOS capability-limit classification now matches Apple SQLite's exact refusal message, so compiled binaries report the honest limit instead of an error.

## 1.6.1 - 2026-07-07

- Updated to SDK 1.3.2: a platform that cannot load SQLite extensions (macOS system SQLite in a compiled binary) now reports an honest capability limit instead of an error; semantic memory search states its literal fallback.

## 1.6.0 - 2026-07-07

- Spoken output now uses the SDK's shared speech engine — the same sentence batching, bounded concurrency, retry, and drain behavior as every other GoodVibes surface, from one implementation.
- Voice settings are shared across surfaces: the provider, voice, and speed configured anywhere (terminal UI, desktop web app, or here) now resolve from one shared configuration file, with the Agent's local setting as fallback.
- Memory operations against an adopted daemon now cover the full record surface (list, edit, link, semantic search, export/import) over the daemon's API, and an older daemon that doesn't serve an operation says so plainly instead of pretending a record doesn't exist.
- Per-turn memory recall reads a freshness-stamped snapshot that states its age and whether the recall floor was applied — the receipt's numbers and its note now tell one coherent story.

## 1.5.9 - 2026-07-06

- Fixed spoken output (text-to-speech) so playback no longer clips at the start: the Agent now waits until the audio player has actually started before sending it audio, instead of writing into a player that hasn't opened yet.
- Fixed responses getting cut off at the end: playback now waits for the audio to fully drain before counting a response as finished, and quitting while the last bit of audio is still playing waits briefly for it to finish instead of killing it mid-sentence. A deliberate interrupt (stopping playback on purpose) still stops instantly.
- Synthesis requests to the voice provider are now batched into as few requests as possible and capped at two running at the same time, so the Agent stays within the provider's concurrent-request limits (for example, an ElevenLabs plan's allowance) instead of firing one request per sentence.
- Transient rate-limit errors from the voice provider now retry quietly in the background instead of stopping playback. If a piece of speech still fails after retrying, that piece is skipped with a single notice and the rest of the response keeps playing normally.

## 1.5.8 - 2026-07-06

- The `memory` CLI command (`goodvibes-agent memory ...`) now writes to the same shared cross-surface memory store that the runtime, the terminal UI, and the SDK already read and write. Previously the CLI opened its own private database, so a memory added from the CLI was invisible everywhere else; a memory added from the CLI is now visible in the Agent runtime, the TUI, and the SDK, and vice versa.
- Memory records written by older CLI versions are not lost: the runtime's existing startup memory merge already reads from the exact path the old CLI wrote to, so those older records are folded into the shared store automatically the next time the runtime starts. No manual migration step is needed.
- Documentation and code-comment hygiene: internal planning shorthand was replaced with plain language in comments, test names, and past changelog entries. No behavior change.

## 1.5.7 - 2026-07-06

- v1.5.7 is a patch on the 1.5 line that completes the platform-SDK adoption started in 1.5.6. The fullscreen Agent workspace, Agent-local behavior, isolated Agent Knowledge, connected-host operator integration, and explicit side-effect boundaries all stay in force; the bundled 1.0.0 GoodVibes platform SDK is unchanged.
- Adopted the platform's shared credential-status read. When the Agent acts as a client of a connected GoodVibes host, it now reads credential *status* — whether each shared-store credential is configured and usable — over the daemon's `credentials.get` route, and renders it honestly: a host with no shared credential store, an older host that does not serve the route yet, or an unreachable host all report a plain "status unavailable" reason. It never shows a fabricated "configured" and never carries a secret value over the wire. Secret *resolution* for provider auth is unchanged and stays local; API keys remain environment-only and are never persisted.
- Completed the memory-unification boot follow-ups. At startup the Agent now folds any legacy per-surface memory into the single cross-surface store and shows the fold report (nothing is silently dropped), migrates existing VIBE.md personality files into durable persona records exactly once — guarded by a persisted marker so the same file is never re-imported into near-duplicate records — and builds the VIBE prompt as a projection of those persona records. The projection preserves the precedence rule verbatim: these vibe instructions are followed only when they do not conflict with explicit user instructions, safety policy, tool contracts, confirmation requirements, or secret-handling rules.
- No change to your conversations, skills, routines, or operator confirmation gates beyond the visibility and memory adoption above.

## 1.5.6 - 2026-07-06

- v1.5.6 is a patch on the 1.5 line. The fullscreen Agent workspace, Agent-local behavior, isolated Agent Knowledge, connected-host operator integration, and explicit side-effect boundaries all stay in force; this release picks up the 1.0.0 GoodVibes platform SDK.
- Updated the bundled GoodVibes platform SDK to 1.0.0 (the 1.0 platform milestone).
- Adopted the platform's renamed operator method ids across the Agent's scheduling and operator surfaces (for example the schedule/reminder/routine edit and pause/resume verbs), so operator actions keep invoking the exact current routes.
- Unified Agent memory onto the single cross-surface store: a fact you teach the Agent is now the same durable memory the GoodVibes TUI reads, and vice versa. Existing per-surface Agent memory is folded into the shared store at startup with no loss, and the VIBE projection renders from the same records.
- Fixed a terminal focus-reporting escape (DECSET ?1004l) that leaked onto standard output when a non-interactive command exited before the TUI started, so scriptable output such as `status --json` stays clean for machine consumers.
- No change to your conversations, skills, routines, or operator confirmation gates beyond the memory unification above; this is a platform-SDK refresh with the accompanying Agent adoption.

## 1.5.5 - 2026-06-30

- v1.5.5 is a patch on the 1.5 line. The fullscreen Agent workspace, Agent-local behavior, isolated Agent Knowledge, connected-host operator integration, and explicit side-effect boundaries all stay in force; this release picks up the latest bundled platform SDK.
- Updated the bundled GoodVibes platform SDK to 0.35.0.
- Realigned the session-lineage tracker test suite with the 0.35.0 SessionLineageTracker contract, which removed .format() in favor of pure state tracking (setOriginalTask, addCompactionEntry, reset, getCompactionCount, getOriginalTask, getEntries); section formatting now lives in buildSessionLineage.
- Fixed the email-style-reply test to import from bun:test instead of vitest, matching the rest of the suite.
- Realigned three more test suites with SDK 0.35.0 runtime behavior: conversation token estimation now charges for image content parts instead of ignoring them, the import-graph specifier extractor now tracks relative side-effect imports, and the fetch tool's timeout error message changed to match the native AbortSignal.timeout() wording.
- Release hygiene: regenerated the strict live-verification attestation against the running connected host so the published package carries current evidence.
- No change to your conversations, memory, skills, routines, or operator confirmation gates; this is an internal dependency and test-alignment update.

## 1.5.4 - 2026-06-30

- v1.5.4 is a patch on the 1.5 line. The fullscreen Agent workspace, Agent-local behavior, isolated Agent Knowledge, connected-host operator integration, and explicit side-effect boundaries all stay in force; this release picks up the latest bundled platform SDK.
- Updated the bundled GoodVibes platform SDK to 0.35.0.
- Realigned the session-lineage tracker test suite with the 0.35.0 SessionLineageTracker contract, which removed .format() in favor of pure state tracking (setOriginalTask, addCompactionEntry, reset, getCompactionCount, getOriginalTask, getEntries); section formatting now lives in buildSessionLineage.
- Fixed the email-style-reply test to import from bun:test instead of vitest, matching the rest of the suite.
- Release hygiene: regenerated the strict live-verification attestation against the running connected host so the published package carries current evidence.
- No change to your conversations, memory, skills, routines, or operator confirmation gates; this is an internal dependency and test-alignment update.

## 1.5.3 - 2026-06-20

- v1.5.3 is a patch on the 1.5 line. The fullscreen Agent workspace, Agent-local behavior, isolated Agent Knowledge, connected-host operator integration, and explicit side-effect boundaries all stay in force; this release picks up the latest bundled platform SDK.
- Updated the bundled GoodVibes platform SDK to 0.34.0. The SDK publishes 17 new additive operator method contracts (channels inbox/routing/drafts, email, and calendar) plus security advisory pins in the SDK's own build dependencies. Existing operator methods and types are unchanged.
- No behavior change in this release: the Agent's inbound channel feed and channel-to-profile routing surfaces stay gated until a daemon release ships the matching handlers (inboundChannelFeed.available remains false; routes remain local_only). The bump only makes the new contracts visible to the operator-method tool so the Agent can detect them once the daemon exposes them.
- No change to your conversations, memory, skills, routines, or operator confirmation gates; this is an internal dependency update.

## 1.5.2 - 2026-06-17

- v1.5.2 is a patch on the 1.5 line. The fullscreen Agent workspace, Agent-local behavior, isolated Agent Knowledge, connected-host operator integration, and explicit side-effect boundaries all stay in force; this release picks up the latest bundled platform SDK and keeps review scoring aligned with it.
- Updated the bundled GoodVibes platform SDK to 0.33.38, so Agent runs on the current shared review, agent, and reporting primitives.
- Tightened review pass/fail reporting to match the updated SDK: a review only passes when its score meets or exceeds the configured threshold. Prose like "passed" or "approved" no longer lifts a sub-threshold score over the bar, removing a path where a weak review could read as a pass.
- Explicit fail language in a review at or above the threshold is still honored as a safety override unless the same review also states it passed, so genuine failures are not silently swallowed.
- No change to your conversations, memory, skills, routines, or operator confirmation gates; this is an internal dependency and scoring-consistency update.

## 1.5.1 - 2026-06-14

- v1.5.1 is a patch on the 1.5 line. The fullscreen Agent workspace, Agent-local behavior, isolated Agent Knowledge, connected-host operator integration, and explicit side-effect boundaries all stay in force; this release restores the inline shell escape and refreshes release verification.
- Restored the inline shell escape in the prompt: type an exclamation mark followed by a command (for example, exclamation-mark git status) to run it in your working directory without leaving Agent. The command output appears inline, and the result is carried into your next message as context so you can run something and immediately ask about it. The composer already showed this as shell mode, but the command never actually ran since the workspace fork; it executes again now.
- The exclamation-hash memory pin is unchanged and still takes precedence, so pinning a note keeps working exactly as before.
- Release hygiene: regenerated the strict live-verification attestation against the running connected host so the published package carries current evidence.
- Test suite: 7931 pass / 0 fail / 2 skip across 554 files.

## 1.5.0 - 2026-06-11

- v1.5.0 opens the 1.5 minor line: the fullscreen Agent workspace remains the primary user surface, Agent-local behavior, isolated Agent Knowledge, connected-host operator integration, explicit side-effect boundaries, and release hardening from 1.3.x and 1.4.x all stay in force. This release replaces the split-pane panel system with the Activity sidebar, rebuilds first-run onboarding around readiness, and adds local calendar, direct email, hardware-aware model recommendations, and skill import/export.
- Replaced the 21-panel split-pane system with a single Activity sidebar. Live activity, process output, and runtime state now surface in one consistent lane instead of stacked panels; the footer was slimmed and tool calls show human-readable labels.
- Rewrote the workspace Home as plain-language lanes and merged duplicate categories. The slash-command long tail moved behind /commands so the prompt surface stays focused on what users actually run.
- Added a While you were away digest on return plus a live Coming up sidebar fed by the local calendar, so upcoming commitments stay visible without asking.
- Rebuilt first-run onboarding around a readiness model: setup steps sequence themselves by what is actually configured, the flow can be resumed midway, and a completion recap shows what was set up. The first screen leads with a working path, the first-run model picker opens with a hardware-fit recommendation, and a plain-language hint appears in conversation while setup is incomplete.
- Competitive parity wave: local calendar support, direct email send and read over SMTP and IMAP with TLS or STARTTLS, hardware-aware model recommendations, and automatic skill drafts.
- Skills now import and export in the open skill standard. Exports are lossless, and skills discovered from imports stay disabled until explicitly enabled.
- Hardened the email and calendar surfaces: SMTP and IMAP commands validate addresses and reject control characters, STARTTLS upgrades verify no data arrives before negotiation completes, and calendar parsing is stricter about malformed input.
- Reliability fixes across the TUI: closed a text-wrap hang, made wide-character rendering consistent, fixed webhook notifier reuse, routed the benchmark editor to its real action, and made command failures surface user-visible errors everywhere.
- Release and verification hygiene: the operator token is redacted from release artifacts, the coverage ledger reports honest numbers, release evidence is checked for existence, and operator-facing copy passes a plain-language gate.
- Test suite: 7931 pass / 0 fail / 2 skip across 554 files.

## 1.4.4 - 2026-06-09

- v1.4.4 continues the stable 1.x line: the fullscreen Agent workspace remains the primary user surface, Agent-local behavior, isolated Agent Knowledge, connected-host operator integration, explicit side-effect boundaries, and release hardening from 1.3.x and 1.4.x all stay in force. This patch finishes the onboarding-modal cleanup begun in 1.4.0–1.4.3.
- Trimmed Model Routing from 23 rows down to a cleaner first-run set. Removed duplicates (account-main-model duplicated provider-use), removed three guidance rows that leaked model-tool syntax in their detail strings (`models action:"status|local|smoke"` etc.), removed the model-only secondary pickers that duplicated provider+model pickers for helper / tool / spoken-turn routes, and grouped the rest into Essentials → Helper/tool/spoken-turn (advanced) → System prompt / custom provider / benchmark (advanced) → Prompt cache (advanced).
- Trimmed Tools & Permissions from 24 rows to 14. Dropped 9 granular per-tool permission settings (find, analyze, inspect, state, registry, mcp, agent, workflow, delegate) that defaulted to safe values and overwhelmed first-time users; the broader policy controls (Permission mode, Auto-approve, file reads / writes / edits, shell, network) stay. Also moved the advanced runtime limits to the bottom of the page.
- Renamed labels to plain English across Start, Model Routing, and Tools & Permissions: "Enable helper model" → "Use a dedicated helper model", "Add MCP server" → "Add an MCP server", etc., so the modal reads like an onboarding wizard, not a configuration dump.
- Trimmed the Model Routing summary and detail so the description fits the harness-text length budget and reads as plain operator UX.
- Tests covering the removed rows are skipped rather than rewritten; the removed settings still exist in the config schema and can be reached via the prompt or future advanced surfaces.
- Test suite: 7553 pass / 0 fail / 67 skip across 548 files. The fullscreen Agent workspace, Agent-local behavior, isolated Agent Knowledge, connected-host operator integration, side-effect boundaries, and release hardening guarantees all remain in force.

## 1.4.3 - 2026-06-09

- v1.4.3 continues the stable 1.x line: the fullscreen Agent workspace remains the primary user surface, Agent-local behavior, isolated Agent Knowledge, connected-host operator integration, explicit side-effect boundaries, and release hardening from 1.3.x and 1.4.x all stay in force. This patch finishes the workspace cleanup.
- Every workspace category now renders the consistent Setting/Default/Current 3-column table. The old Option/Does fallback was confusing users who saw two different page styles across the same modal. Non-setting rows (editors, model pickers, settings modals, guidance) show their label in Setting and a placeholder dash in Default/Current.
- Removed every `kind: 'command'` slash-command row from the workspace categories — 145 rows gone. The modal is not a redundant slash-command launcher; the slash commands themselves still work in the main prompt. This applies across the full category list, not just the ONBOARDING group.
- Reordered the Start (setup) category so a first-time user sees the essentials first: sign in to a provider, finish sign-in, choose main model, then optional settings import, reasoning effort, and save-history toggle. The advanced rows (custom provider, stored credentials, secret storage policy, resume-point controls) moved to the bottom of the page where they don't clutter first-run.
- Renamed several Start rows to plain English: "Start subscription login" → "Sign in to a provider", "Finish subscription login" → "Finish provider sign-in", "Logout subscription" → "Sign out of a provider", "Setup checkpoint show/save/clear" → "Show/Save/Clear saved resume point".
- Tests covering the removed command-row dispatch paths are skipped rather than rewritten; the slash commands still exist as commands, just not as workspace rows.
- Test suite: 7556 pass / 0 fail / 64 skip across 548 files.

## 1.4.2 - 2026-06-08

- v1.4.2 continues the stable 1.x line: the fullscreen Agent workspace remains the primary user surface, Agent-local behavior, isolated Agent Knowledge, connected-host operator integration, explicit side-effect boundaries, and release hardening from 1.3.x and 1.4.x all stay in force; 1.4.2 removes a planning feature that did not belong in this product and finishes the onboarding-modal cleanup.
- Removed the project planning subsystem entirely. The `/plan` and `/workplan` slash commands, the project-planning panel, the work-plan panel, the planning runtime coordinator, and all related workspace categories are gone. This is an operator assistant, not a coding planning harness, and the planning interceptor at `src/planning/project-planning-coordinator.ts` was matching the word `plan` in any user prompt and auto-opening a panel that captured keyboard focus.
- Stopped the onboarding modal from exiting the user mid-flow. The Phase 1 default dispatch behavior was `compose`, which closed the modal before running the slash command. The new default is `inline`: editor submissions, settings imports, and ad-hoc commands now stay inside the workspace and surface their output in the result pane. Only `commandBehavior: 'compose'` (explicit) or `'exit'` (only `/quit`) closes the modal.
- Forced the consistent Setting/Default/Current 3-column table layout on every ONBOARDING category. Pages with mixed-kind action lists (editor + setting + guidance) previously fell back to the old two-column Option/Does layout, so users saw two different page styles across the onboarding flow. Now every onboarding page uses the same 3-column header, and non-setting rows show their action label in the Setting column with placeholder dashes for Default and Current.
- Removed every onboarding workspace row that referenced the deleted planning feature: `personal-ops-workplan`, `personal-ops-workplan-add`, `workplan`, `workplan-show`, `workplan-add`, `workplan-status`, `workplan-delete`, `workplan-clear-completed`, `planning-status`, `planning-mode`, `planning-explain`, `planning-list`, `plan-seed`, `plan-show`, `plan-approve`, `plan-override`, `plan-clear`. Help overlay and docs cleaned of `/plan` and `/workplan` mentions.
- Trimmed the agent-boundary docs test that previously asserted on the deleted 1.2.0 repair handoff doc, plus the release-evidence test now targets a stable required theme instead of a 1.3.0-specific phrase.
- Test suite: 7601 pass / 0 fail / 19 skip across 548 files.

## 1.4.1 - 2026-06-08

- v1.4.0 was cut but its publish step never ran; v1.4.1 ships the same onboarding rebuild as the first publicly published version of the 1.4.x line. The fullscreen Agent workspace, Agent-local behavior, isolated Agent Knowledge, connected-host operator integration, explicit side-effect boundaries, and release hardening from 1.3.x all stay in force.
- Fixed a release-evidence test that hardcoded a 1.3.0-specific phrase (`compact model-visible harness pass`) and prevented the v1.4.0 publish workflow from completing. The assertion now targets the stable required-theme `fullscreen Agent workspace`, so future release-notes rotations no longer break release CI.
- Rebuilt the Agent Workspace onboarding modal so first-time users land in a focused ONBOARDING-only category list, no longer see HOME and post-onboarding categories competing for attention, and never get kicked out of the modal when activating a slash-command row.
- Added typed `commandBehavior` (inline | compose | exit) on workspace actions so safe read-only commands can run inside the onboarding modal with their captured output rendered into the result pane, instead of forcing the modal closed to dispatch through the composer.
- Guarded the new inline dispatch path so a missing `executeCommand` no longer clobbers `context.print`; the modal surfaces a clear "command unavailable" result and stays open.
- Replaced release-engineering vocabulary (smoke history, receipt gaps, durable receipt, closeout policy, schema status, event cursor, publication guarantee, step history, repeated blocker, setup checkpoint summary) with a tight progress + single next-action summary in the onboarding right pane.
- Closed a leak where channel-guide context lines could expose internal `userRoute` strings containing model-tool-call syntax; the channels guide now shows only human-readable labels.
- Trimmed the user-facing setup checklist from fifteen items to thirteen by removing the `install-smoke` and `browser-pwa` release-engineering items; both remain available to model-facing routes but no longer appear in the onboarding flow.
- Renamed the misleading `command` field on `AgentWorkspaceSetupChecklistItem` to `breadcrumb` so the field's purpose (UI navigation hint) no longer collides with the `kind: 'command'` action type.
- Added clear verb-led row labels in the onboarding modal so users can see exactly what activating a row does: "Choose provider and model", "Edit MCP server", "Switch to <category>", "Run: <command>", "Open: <command>", "Finish setup", and so on, replacing generic labels like "Open option" and "Open guided form".
- Added a sticky "Finish setup" footer row visible on every ONBOARDING category, colored green when prerequisites (provider/model, connected-host auth, runtime) are ready and warn-colored with the unmet items listed otherwise; the row is wired through the real activation path so pressing Enter triggers `completeOnboarding()`.
- Added per-category readiness glyphs in the onboarding left pane: a green checkmark for categories whose mapped checklist items are all ready, a warn glyph for categories with blockers or recommended items, and no glyph for optional-only categories.
- Relocated the diagnostic fields on `AgentSetupWizard` (smokeHistory, stepHistory, receiptGaps, closeout, checkpoint, repeatedBlocker) under a `_diagnostic` subkey so model-facing wizard mechanics are cleanly separated from user-facing wizard state, while preserving the existing model-tool surface.
- Tightened `AgentWorkspaceCategory.group` and the workspace `_onlyGroup` filter to a literal union `AgentWorkspaceCategoryGroup`, so category-group typos fail at compile time instead of producing silent navigation bugs.
- Added end-to-end acceptance tests for the new behavior: inline command dispatch keeps the workspace active and populates `lastActionResult` with captured output, first-run filter restricts the modal to ONBOARDING categories only, and the jargon allowlist guarantees no banned vocabulary leaks back into user-facing copy.

## 1.4.0 - 2026-06-08

- Continued the stable 1.x line: the fullscreen Agent workspace remains the primary TUI surface, Agent-local behavior, isolated Agent Knowledge, connected-host operator integration, explicit side-effect boundaries, and release hardening all stay in force; 1.4.0 sharpens the onboarding flow inside that surface.
- Rebuilt the Agent Workspace onboarding modal so first-time users land in a focused ONBOARDING-only category list, no longer see HOME and post-onboarding categories competing for attention, and never get kicked out of the modal when activating a slash-command row.
- Added typed `commandBehavior` (inline | compose | exit) on workspace actions so safe read-only commands can run inside the onboarding modal with their captured output rendered into the result pane, instead of forcing the modal closed to dispatch through the composer.
- Guarded the new inline dispatch path so a missing `executeCommand` no longer clobbers `context.print`; the modal surfaces a clear "command unavailable" result and stays open.
- Replaced release-engineering vocabulary (smoke history, receipt gaps, durable receipt, closeout policy, schema status, event cursor, publication guarantee, step history, repeated blocker, setup checkpoint summary) with a tight progress + single next-action summary in the onboarding right pane.
- Closed a leak where channel-guide context lines could expose internal `userRoute` strings containing model-tool-call syntax; the channels guide now shows only human-readable labels.
- Trimmed the user-facing setup checklist from fifteen items to thirteen by removing the `install-smoke` and `browser-pwa` release-engineering items; both remain available to model-facing routes but no longer appear in the onboarding flow.
- Renamed the misleading `command` field on `AgentWorkspaceSetupChecklistItem` to `breadcrumb` so the field's purpose (UI navigation hint) no longer collides with the `kind: 'command'` action type.
- Added clear verb-led row labels in the onboarding modal so users can see exactly what activating a row does: "Choose provider and model", "Edit MCP server", "Switch to <category>", "Run: <command>", "Open: <command>", "Finish setup", and so on, replacing generic labels like "Open option" and "Open guided form".
- Added a sticky "Finish setup" footer row visible on every ONBOARDING category, colored green when prerequisites (provider/model, connected-host auth, runtime) are ready and warn-colored with the unmet items listed otherwise; the row is wired through the real activation path so pressing Enter triggers `completeOnboarding()`.
- Added per-category readiness glyphs in the onboarding left pane: a green checkmark for categories whose mapped checklist items are all ready, a warn glyph for categories with blockers or recommended items, and no glyph for optional-only categories.
- Relocated the diagnostic fields on `AgentSetupWizard` (smokeHistory, stepHistory, receiptGaps, closeout, checkpoint, repeatedBlocker) under a `_diagnostic` subkey so model-facing wizard mechanics are cleanly separated from user-facing wizard state, while preserving the existing model-tool surface.
- Tightened `AgentWorkspaceCategory.group` and the workspace `_onlyGroup` filter to a literal union `AgentWorkspaceCategoryGroup`, so category-group typos fail at compile time instead of producing silent navigation bugs.
- Added end-to-end acceptance tests for the new behavior: inline command dispatch keeps the workspace active and populates `lastActionResult` with captured output, first-run filter restricts the modal to ONBOARDING categories only, and the jargon allowlist guarantees no banned vocabulary leaks back into user-facing copy.

## 1.3.0 - 2026-06-08

- Promoted GoodVibes Agent to the stable 1.0.x operator product surface: the fullscreen Agent workspace is the primary TUI, with setup, provider/model routing, status, compatibility, and doctor flows shaped around personal operator use instead of copied host lifecycle controls.
- Completed the Agent-local behavior system for day-one operation: VIBE.md personality, project context files, local memory posture, prompt-active recall, vector/embedding health, notes, personas, skills, skill bundles, routines, starter profiles, discovery/import flows, review/stale/delete controls, and secret-looking content rejection all stay under Agent ownership.
- Completed isolated Agent Knowledge coverage across CLI, slash commands, workspace panels, connector/source/node/issue views, URL/file/browser/connector ingest, semantic ask/search, issue review, packet/explain previews, consolidation, reindex, and connected-host `/api/goodvibes-agent/knowledge/*` routes without fallback to default or non-Agent knowledge surfaces.
- Completed connected-host operator integration without taking host lifecycle ownership: compatibility/status checks, authenticated health and model routes, channel readiness, provider-account posture, approvals, automation snapshots, schedules, work plans, media/voice readiness, pairing, and explicit public-route diagnostics are all visible from Agent.
- Completed explicit side-effect boundaries for personal operation: channel sends, notifications, autonomous schedule creation, schedule enable/disable/delete, routine schedule promotion, reminders, subscription/auth actions, memory bundle imports/exports, support bundles, MCP configuration, profile changes, and build delegation require explicit confirmation where they mutate state or call external routes.
- Added first-class user-task route planning: `route action:"plan|status"` and lower-level `agent_harness mode:"route_decision"` turn a plain request into the preferred visible Agent route, alternatives, missing fields, confirmation boundary, workspace matches, and harness mode matches without running tools or creating hidden work, including screenshot/browser-control requests that now route to `computer action:"plan"`.
- Host/daemon health, doctor, readiness, service, and compatibility requests now route to `host action:"status"` first before setup repair or service lifecycle effects.
- Normal settings/configuration requests now route to `settings action:"list"` first so setting changes start with Agent-owned discovery and explicit confirmation boundaries.
- Direct reminders, schedules, cron, and schedule lifecycle requests now route to `schedule action:"list"` first, while broader ongoing work remains on autonomy intake.
- Plain command-shaped background work now routes to `execution action:"processes"` and the first-class `terminal`/`process` UX, while scheduled or watcher-like background work stays on autonomy intake.
- Interactive terminal, PTY, stdin, and sudo requests now route to `execution action:"process_capabilities"` first so users see current support, setup posture, and confirmation boundaries before any hidden process start or credential effect.
- External memory-provider, backend, cross-session sync, import/export, and named-provider requests now route to `memory action:"provider"` or the external provider checklist before Agent promises provider writes, sync, credentials, or import/export effects; provider detail also exposes next-route packets, missing setup/status/read/write/sync checks, and required receipt fields for SDK/daemon records Agent can consume.
- Model provider, local-cookbook, local server smoke, and route-fit requests now route to `models action:"provider|local|smoke|route"` before Agent attempts credential, smoke, benchmark, or route-change effects.
- Browser-backed research runner requests now route to `research action:"runner"`, and visual research report rendering requests route to `research action:"plan"` plus report artifacts before Agent claims browser/PWA rendering readiness.
- Voice workflow, TTS-provider, browser cockpit, and PWA requests now route to `device action:"voice|provider"` or `computer action:"browser"` before Agent attempts capture, playback, picker, or browser-open effects.
- Personal Ops briefing, saved queue, fresh inbox/calendar read, and connector setup requests now route to `personal_ops action:"briefing|queue|intake|lane"` before Agent attempts live provider reads or effects.
- Channel setup, triage, delivery receipt, and send requests now route to `channels action:"setup|triage|deliveries|channel"` before Agent attempts confirmed external delivery.
- Plain file undo/redo/recovery requests now route to `execution action:"recovery"` so users inspect available snapshots before confirming a local file mutation.
- Media generation requests now route to provider readiness and confirmed `agent_media_generate` saved-artifact output instead of inline bytes or silent Knowledge promotion.
- Permission posture, security finding, and blocked-action questions now route to `security action:"status|finding|explain"` so users get active permission state, exact redacted findings, or read-only policy preflight without knowing security harness mode names.
- Support-bundle, saved-session/bookmark, and release/audit evidence requests now route to first-class read-only `support action:"status|bundle"`, `sessions action:"list|get"`, and `audit action:"readiness|evidence|item|artifact"` before bundle export/import/share, session lifecycle, or audit drill-in effects.
- Added first-class setup repair decisions: `setup action:"repair"` and lower-level `agent_harness mode:"setup_repair"` choose the next safe token repair, connected-host status, services.status receipt, user-run bootstrap, or no lifecycle action without executing lifecycle, token, import, or UI effects.
- Added first-class policy explanations: `security action:"explain"` and lower-level `agent_harness mode:"policy_explain"` show why one model action is allowed, denied, or waiting on confirmation across the Agent route guard, permission mode, and typed tool confirmation, with secret-looking args redacted and no tool execution.
- Added user-first delegation decision cards and structured handoff briefs: execution and delegation posture now distinguish local-first work, TUI handoff, delegated review, remote inspection, and blocked hidden fanout, while `/delegate` and the Agent Workspace form preserve reason, success criteria, workspace hints, priority, and explicit review intent.
- Added the first-class `delegation` tool: `action:"status|routes|route"` exposes delegation policy, route catalogs, and exact confirmed handoff contracts without requiring harness mode names.
- Added the first-class `execution` tool: `action:"status|route|history|record|processes|process_capabilities|process|recovery"` exposes local-vs-delegated work posture, exact route inspection, activity cards, tracked process inspection, direct process parity/doctor reporting, and file recovery without requiring harness mode names.
- Added the first-class `computer` tool: `action:"status|plan|control|browser|setup|mcp|open_browser"` exposes browser/PWA readiness, browser/screenshot/desktop-control route planning, repair/setup rows, trusted MCP/tool discovery, and confirmed browser cockpit opens without requiring harness mode names.
- Added normalized autonomy queue controls: research runs, connected-host tasks, approvals, automation runs, and schedules now expose available/unavailable controls with reasons plus exact confirmed routes for checkpoint, pause, resume, cancel, approve, deny, retry, run, edit, enable, disable, and delete actions; host task cancel/retry stays on confirmed `agent_operator_method` routes while `/tasks` remains inspection-only.
- Added the first-class `autonomy` tool: `action:"intake|queue|item|status"` exposes ongoing-work route selection and visible autonomy queue inspection without requiring harness mode names.
- Added trigger workflow posture: `autonomy action:"intake"` now maps time-based wakeups/schedules, incoming webhook/event watchers through published `watchers.*` daemon routes, Gmail/email connector-gated triggers, and read-only control-plane event streams, with watcher creation kept admin-confirmed and source-scoped.
- Added certified watcher receipts: `autonomy action:"intake"` now exposes watcher success criteria, and `agent_operator_method` summarizes `watchers.create/patch/run/start/stop/delete` receipts into certified or follow-up outcomes without exposing operator tokens.
- Added a source-owned watcher evidence contract: `autonomy action:"intake"` now tells users and models which SDK/daemon-owned durable run-history receipts, provider source records, redacted event payload descriptors, and queue correlation records are needed before Agent claims persisted webhook/Gmail watcher history.
- Added live watcher run/source read-model consumption: the autonomy queue now ingests SDK/daemon watcher run history, automation watcher runs, Gmail/email provider sources, bounded redacted watcher output chunks, source/checkpoint/correlation diagnostics, read-only source inspect/refresh controls, and exact confirmed watcher controls only when the owning host publishes those routes.
- Added host task output posture: autonomy queue connected-host task records now expose `/tasks output` routes plus bounded redacted result/error previews when the host publishes them, and route-only status when true output text is not in the read model.
- Completed package and release hardening for the release gate: Bun-only install/run instructions, package-facing text verification, package runtime bundling, packed global install smoke, blocked lifecycle command smoke, source/package boundary checks, architecture checks, recorded performance snapshot checks, verification ledger, strict live verification artifacts, and release-quality readiness inventory dimensions are now part of the validated release path.
- Completed the compact model-visible harness pass: `agent_harness` summary now starts with an assistant-first cockpit before technical counters, plural catalogs default to compact rows, `mode:"modes"` searches every harness mode by task/id/effect/parameter, and `mode:"mode"` inspects one mode contract with full schemas, policy blocks, route metadata, editor fields, release artifact detail, redacted log tail, and parameter detail behind `includeParameters:true` or singular inspect modes.
- Added a first-class `workspace` adapter for workspace actions, panels, UI surfaces, slash commands, CLI mirrors, keybindings, and fixed shortcuts, so the model can inspect or confirm visible workspace operations without memorizing harness mode names; lower-level harness modes remain for detailed route inspection and compatibility.
- Added ordered channel setup guide: Agent Workspace -> Channels, `/channels guide`, and `channels action:"setup"` now rank the next channel and walk through setup schema, secret-backed settings, delivery target, allowlist policy, live status/doctor checks, and explicit confirmed test-send boundaries.
- Added channel triage: Agent Workspace -> Channels, `/channels triage`, and `channels action:"triage"` now unify setup blockers, daemon delivery attempts, visible surface messages, route bindings, and redacted Agent receipts without claiming provider-specific unread inbox polling.
- Added channel delivery receipts: confirmed `/channels send` and `agent_channel_send` deliveries now write Agent-owned redacted receipt history, visible through Agent Workspace -> Channels, `/channels deliveries`, and `channels action:"deliveries"`.
- Added route-backed browser and desktop control setup posture: `setup action:"status|item"` plus `execution action:"status|route"` now show ready, attention, or setup-needed state, workflow cards, setup checklists, fallback routes, and MCP review routes for browser, desktop, computer-use, screenshot, or screen-recording tooling; lower-level `setup_posture`, `setup_item`, `execution_posture`, and `execution_route` remain compatibility routes.
- Added connected browser cockpit routing: Home, `computer action:"browser|open_browser"`, `workspace action:"surface|open"`, and lower-level UI surface detail routes now expose the configured connected-host browser cockpit/PWA URL with service/web setup fallback, workspace-category coverage, mobile/PWA controls, Agent onboarding marker status, and an honest browser/PWA first-run receipt contract that can be satisfied by artifact or live setup read-model receipts when the host publishes them.
- Added certified browser/PWA read-model consumption: `computer action:"browser"` and the connected browser cockpit surface now consume SDK/daemon browser-native Agent workspace category routes and browser/PWA first-run receipts with schema/version/publication/publisher/provenance/freshness-cursor/receipt metadata, exact inspect/open routes, mobile/touch controls, manifest/service-worker/install/offline evidence, redacted URLs/summaries, and missing-signal surfacing before reporting `browser-native-ready`.
- Added companion device capability mapping: `device action:"status|capability"` and lower-level `pairing_posture` / `pairing_route pairingRouteId:"device-capability-map"` now show ready/attention/setup-needed/not-published posture for companion pairing, mobile command routing, browser/PWA, voice controls, spoken responses, notifications, browser/desktop control, and camera/screen/location sensors without returning raw tokens or claiming unpublished device APIs.
- Added certified companion device read-model consumption: device capability and voice workflow posture now consume SDK/daemon permission-scoped camera, screen, location, local device command, and wake-word records with schema/version/publication/publisher/provenance/freshness-cursor/receipt metadata, exact inspect/control routes, redacted summaries, and missing certification signals.
- Added voice workflow posture: `device action:"voice"` and lower-level `media_posture` now map push-to-talk input, voice memo transcription, spoken responses, and wake-word capture with ready/attention/setup-needed/not-published state, setup routes, runtime evidence, and explicit policy that always-listening capture requires certified permission-scoped runtime evidence.
- Surfaced voice/device/browser posture in Voice & Media: the workspace now has Voice workflows, Device capability map, and Browser/PWA readiness actions with direct `device` and `computer` route hints.
- Added sudo execution posture: `execution action:"status|route"`, `setup action:"status"`, `setup action:"item" setupItemId:"sudo-execution-posture"`, and `process action:"capabilities"` now expose foreground-supervised escalation guidance, SUDO_PASSWORD presence-only status, blocked background sudo/stdin password routes, and missing SDK/daemon mediation contracts without reading or printing raw password values.
- Added connected-host setup repair cards: expanded `setup_posture` and `setup_item` rows now expose status/service diagnostics plus confirmed service install/start/restart `agent_operator_method` routes when the SDK operator contract supports them, while first-run setup excludes service stop/uninstall.
- Added probe-fed setup repair recommendations: connected-host setup now includes live service probe evidence, recommends diagnostics/status first, and keeps service install/start/restart as inspect-first confirmed routes until service status proves they are needed.
- Added certified service repair receipts: setup repair cards now include success criteria and verification routes, and `agent_operator_method` summarizes services.status/install/start/restart receipts into certified or follow-up outcomes without exposing the operator token.
- Added service lifecycle receipt decisions: setup posture now exposes serviceLifecycleDecision gates, and `agent_operator_method methodId:"services.status"` maps returned installed/running/control-plane evidence to exact install, start, restart, or no-action guidance before any lifecycle mutation.
- Added connected-host auth setup posture: first-run setup now has a token-safe connected-host auth row for missing/usable operator token state, fingerprint-only token evidence, `/auth review` guidance, exact pairing route ids, confirmed SDK-backed local token create/repair, and regression fixtures for missing-host, reachable-host, missing-token, and unconfigured-model setup paths.
- Added setup smoke execution: first-run setup now includes a token-safe install smoke row plus confirmed `setup action:"smoke"` evidence collection from package binary/version/status to connected-host status, auth posture, provider/model routing, setup posture, one first assistant turn, optional saved redacted evidence artifacts, and Home/setup latest-result plus history/trend/frequent-blocker surfacing without running shell commands implicitly.
- Added guided setup wizard: the Start workspace and `setup_posture` now expose progress, current-step routes, backtracking routes, setup-smoke rerun/save routes, and repeated-blocker focus from saved smoke evidence so first-run repair feels like one guided flow instead of a loose checklist.
- Added saved setup wizard checkpoints: Start and `setup action:"status"` now show the saved resume state, stale checkpoint auto-advance evidence, Start show/save/clear checkpoint actions, and `setup action:"checkpoint|save_checkpoint|clear_checkpoint"` inspect or mutate only Agent-owned step resume metadata after confirmation.
- Added setup closeout: Start and `setup action:"status"` now expose `setupWizard.closeout` / `setupCloseout` decisions that reduce critical setup blockers, saved setup smoke evidence, and the user onboarding completion marker into blocked, needs-smoke-evidence, ready-to-finish, or complete states; confirmed `setup action:"finish"` writes only the user onboarding markers.
- Added live setup receipt consumption: Start, setup checklist, setup wizard history, and setup closeout now merge saved setup-smoke artifacts, durable connected-host setup receipt artifacts, SDK/daemon setup receipt read-model snapshots, and ordered setup receipt event streams; ready service/auth/install-smoke/browser-PWA receipts auto-advance the matching rows, blocked receipts stay visible, schema/version/provenance/publication/cursor evidence is surfaced when certified receipts publish it, and secret-looking receipt summaries are redacted.
- Added first-run local model readiness: `setup action:"status"` and `setup action:"item"` now include a local-model readiness row with detected local stacks/routes, top cookbook recipe, readiness score, benchmark follow-through, and exact model-routing inspect routes.
- Added Personal Ops connector tool classification: expanded inbox and calendar lanes now read MCP tool metadata when available, classify read-only versus write-like email/calendar tools, and carry those capability tags into connector records and workflow prerequisites.
- Added Personal Ops schema-derived operation records: expanded inbox and calendar lanes now turn reviewed MCP schemas into required-field/sample-input/schema-route cards with explicit confirmation flags for send/edit-like actions.
- Added Personal Ops execution plans: request intake now returns ordered connector-read, local-compose, setup-repair, and confirmed-effect steps so inbox/calendar work is legible before any live provider action.
- Added confirmed Personal Ops read execution: `personal_ops action:"read"` (backed by `run_personal_ops_read`) runs one selected read-only inbox/calendar MCP operation after required-field and confirmation checks, refuses write-like tools, and returns bounded redacted output plus normalized review cards; users can also request a saved redacted review-card artifact without storing full raw connector output or full input values.
- Added next-route packets to confirmed Personal Ops reads so refreshed reads, lane/queue inspection, saved artifact reopen, local reply/reminder drafting, and send/calendar-edit boundaries are explicit structured routes after one read completes.
- Added Personal Ops saved review queues: saved inbox/calendar review artifacts now resurface as redacted thread/event queue records with artifact inspect routes, freshness status, confirmed refresh routes when a matching read connector is ready, local draft/reminder follow-up routes, and explicit confirmed provider-effect boundaries.
- Added the direct Personal Ops review queue: `personal_ops action:"queue"` aggregates saved inbox thread/calendar event review items, fresh provider-read routes, daemon/SDK provider read-model records, refresh routes, and follow-up confirmation boundaries without executing MCP tools or mutating artifacts.
- Added certified Personal Ops provider read-model consumption: inbox and calendar lanes now ingest fresh daemon/SDK-published provider-backed thread and event records with durable ids, labels, redacted snippets, agenda windows, conflict signals, source paths, freshness metadata, schema/version/publication/publisher/provenance/receipt evidence, read-only inspect routes, and confirmed follow-up routes only when reply/send/label/archive/edit/RSVP/delete routes are explicitly published.
- Added certified Personal Ops task/reminder read-model consumption: task and reminder lanes now ingest fresh daemon/SDK-published provider-backed task and reminder records with durable ids, due times, priorities, cadence, delivery targets, redacted notes, source paths, freshness metadata, schema/version/publication/publisher/provenance/receipt evidence, read-only inspect routes, and confirmed follow-up routes only when update/complete/defer/snooze/delete routes are explicitly published.
- Added Personal Ops provider-effect receipt certification: inbox, calendar, task, and reminder lanes now resurface certified provider-effect receipts for sends, labels, archive, edits, RSVP, update, complete, defer, snooze, and delete outcomes with redacted publication guarantees and receipt ids before Agent claims provider effects succeeded.
- Added Personal Ops task/reminder workflows: task lanes now separate visible work-plan actions from connected-host task inspection/control, and reminder lanes now expose confirmed reminder creation, autonomous schedule creation, schedule review, run, pause/resume, and exact-id control records.
- Added Personal Ops daily briefings: `personal_ops action:"briefing"` and the visible Daily briefing plan action now assemble one read-only user-first plan across inbox, agenda, tasks, reminders, routines, delivery, notes, and autonomy queue before any live personal-data read or effect.
- Added the first-class `personal_ops` adapter: `action:"briefing|status|queue|intake|lane"` exposes the safe Personal Ops discovery flow directly, while confirmed `action:"read"` preserves the existing one-operation inbox/calendar read boundary with required fields, redaction, and optional saved review cards.
- Added research runner posture: `research_runs` now exposes browser-backed research readiness, setup and fallback routes, source review, report save, Knowledge promotion routes, and policy so deep research requests do not pretend browser execution is ready when only web/fetch research is available.
- Added visual research report packets: `research action:"report" visualReport:true` now appends at-a-glance, evidence matrix, findings board, dated source/comparison, open-question, next-action, and handoff-checklist sections to the saved sourced artifact while preserving citation coverage metadata and no transcript body dump.
- Added guided learning consolidation execution: `memory action:"curator"` now returns an ordered duplicate-consolidation batch plan and first-class `agent_learning_consolidation` preview/merge/stale/delete/rollback/recreate routes; merge and stale phases write durable receipts, delete refuses duplicates that have not been staged stale, post-delete receipts preserve snapshots with exact-id recreate guidance, and confirmed recreate refuses unsafe id collisions before restoring deleted duplicates.
- Added learning prompt plans: `memory action:"curator"` now returns prompt-active records, suppressed review/setup/low-confidence/personality/consolidation counts, proposal queues, consolidation queues, and usefulness/freshness/source-quality/risk ordering rules so users and the model can see what may guide the assistant now before durable context expands.
- Added prompt context inspection and receipts: prompt builds now write durable sanitized receipt ids with turn/source/model/provider, selected and suppressed record refs, segment counts, prompt hash, size, timestamp, and completed/error/cancelled outcome without storing raw prompt or response text; Agent Workspace -> Local Context shows a compact receipt outcome timeline with exact latest-receipt drill-in and outcome filter routes, and `context action:"prompt|receipts|receipt"` exposes recent receipts, exact `receiptId`/`turnId`/`outcomeStatus` filters, turn outcomes, applied prompt composition order, selected VIBE.md/project context/memory/routine/skill/persona records, suppressed records, prompt previews on request, and approximate token budget without mutating local behavior.
- Added missing-host setup bootstrap: `setup action:"item"` for connected-host readiness now returns user-run GoodVibes host install, trust, binary verification, service start, and Agent reconnect commands before operator methods are reachable.
- Added first-class model/provider routing: `models action:"status|route|local|providers|provider|smoke"` now fronts model route readiness, provider/subscription posture, local model cookbook, exact route/provider lookup, and confirmed local server smoke checks while lower-level harness modes remain available for detail.
- Added model readiness scoring: `model_routing`, `model_route`, and the local model cookbook now expose estimated 0-100 readiness across latency, context window, tool support, vision, cost, and privacy while clearly flagging missing live benchmarks; the visible Model Routing lane now has an `Inspect route readiness` action for that read-only posture.
- Added route-level provider-health consumption: exact model-route readiness now consumes daemon-published provider and model-route health records with source ids, live latency, rate-limit posture, and redacted error posture before using benchmark latency as fallback evidence.
- Added local server endpoint checks: the local model cookbook now maps detected local provider/model registry endpoints and local base URL environment hints into exact endpoint inspect routes, model-list smoke commands, success criteria, failure triage, confirmed `models action:"smoke"` checks for detected or default local endpoints, refresh routes, provider-add hints, suggested defaults, and a visible `Check local servers` workspace action without running a hidden network probe.
- Added certified daemon-published local serving diagnostics consumption: local cookbook and exact endpoint inspection now surface schema/version/provenance/publication/publisher evidence, server version, loaded models, context/tool support, resource pressure, start/repair receipt ids, receipt status, source read-model path, exact confirmed start/repair routes when host-published, and redacted summaries while smoke checks, refresh, provider edits, benchmarks, and route changes remain separate confirmed actions.
- Added local model benchmark execution and evidence: the Model Routing workspace now includes a confirmed local benchmark action backed by `agent_model_compare` with `benchmarkKind:"local-model-route"` plus a `Review benchmark evidence` action for saved comparisons, revealed winner judgments, and filtered analytics before any separate default-model apply action.
- Added the visible assistant cockpit to TUI Home: the existing renderer now opens on the same setup, chat/model, project work, Personal Ops, research/docs, background supervision, and safety/recovery lanes as `agent_harness mode:"summary"`, while deeper subsystem details stay in categories and search.
- Tightened local behavior prompt quality gates: reviewed memory now requires the durable confidence threshold, and skills, routines, bundles, and personas only steer the assistant when reviewed and setup-ready; suppressed behavior remains visible as review/setup work.
- Added memory posture UX: `memory action:"status|provider|list|search|get"` now exposes Agent-local memory counts, direct record lookup/search, prompt-active recall, vector stats, embedding-provider doctor warnings, provider inspection, and external-memory setup contract maps for Honcho, OpenViking, Mem0, Hindsight, Holographic, RetainDB, ByteRover, Supermemory, and daemon-published similar backends, including provider-specific next routes, certified schema/version/publication/publisher/provenance checks, setup/status/read/write/sync/forget checklist items, required receipt fields, certified durable receipt evidence, and sanitized live provider read-model consumption when the SDK/daemon publishes setup/status/read/write/sync/forget records.
- Added background-process parity reporting: `process action:"capabilities"` now maps terminal background start plus process list/poll/wait/log/kill/write, PTY, and sudo semantics to supported routes or explicit SDK/daemon contract gaps, with lower-level lifecycle aliases still accepted for compatibility.
- Improved background process logs: `execution action:"process"` and `process action:"log"` now return redacted stdout/stderr tails with byte counts, character counts, truncation flags, and direct process-style routes.
- Added first-class terminal/process adapters: `terminal command:"..." background:true` starts a visible tracked local process, while `process action:"list|poll|wait|log|kill|write"` manages the same ProcessManager records with the existing confirmation and unsupported PTY/stdin/sudo boundaries.
- Added a first-class schedule adapter: `schedule action:"list|create|remind|edit|run|pause|resume|delete"` routes recurring work, reminders, exact schedule edits, and lifecycle controls through the existing preview, confirmation, current-state diff, and allowlisted connected-host schedule paths.
- Added post-action next routes for schedules: confirmed autonomous schedule creation, routine promotion, reminders, schedule edits, and schedule lifecycle controls now return schedule list, autonomy queue, run, edit, pause, resume, and delete routes without weakening confirmation gates.
- Added pre-confirmation schedule handoffs: autonomous schedule, reminder, routine-promotion, and schedule-edit previews now include explicit confirmation routes while remaining non-mutating.
- Added a first-class setup adapter: `setup action:"status|item|repair|checkpoint|save_checkpoint|clear_checkpoint|token|smoke|finish|import_settings"` gives first-run setup a short user-intent route while delegating to the existing wizard, repair decision, token, smoke, closeout, and settings-import implementations.
- Added a first-class VIBE.md adapter: `vibe action:"status|show|init|import_persona"` gives personality setup a short user-intent route while preserving secret scans, confirmation gates, and Agent-local persona boundaries; unconfirmed init/import previews now include exact model and CLI `confirmationRoutes`.
- Added a first-class settings adapter: `settings action:"list|get|set|reset|import"` fronts Agent settings and GoodVibes settings import preview/apply without requiring the model to know harness settings modes or the workspace action id.
- Shared GoodVibes settings import previews now include source-package ownership metadata so users can reuse goodvibes-tui or other published GoodVibes platform settings without Agent mutating source package stores.
- Added a first-class host adapter: `host action:"status|capabilities|capability|services|service|methods|method"` fronts connected-host status, capability maps, service posture, endpoint detail, and daemon method inspection while preserving exact execution on `agent_operator_method`.
- Added a first-class device adapter: `device action:"status|capability|browser|control|voice|provider|open_browser|open_tts_provider|open_tts_voice"` keeps companion, mobile/PWA compatibility, voice/TTS, browser/desktop-control compatibility, provider posture, and visible browser/TTS picker handoffs available while preserving confirmation gates; `computer` is now the primary browser/PWA and desktop-control route.
- Added a first-class research adapter: `research action:"briefing|plan|search|runner|runs|run|sources|source|bundle|reports|report_artifact|create_run|start_run|checkpoint|pause|resume|cancel|complete|fail|delete_run|add_source|review_source|reject_source|use_source|delete_source|report"` gives deep research one user-facing route over a read-only next-action queue, workflow planning, bounded public source-candidate search, browser-runner readiness, visible run lifecycle, source triage, reviewed-source bundles, saved report inspection, and sourced report artifacts while preserving existing confirmation gates.
- Added dynamic background-process capability probing: the process parity report now detects ProcessManager stdin/PTY methods, terminal/PTY operator methods, GoodVibes session-input routes, and credential routes, and `processAction:"write"` dispatches through a discovered safe ProcessManager stdin method only after explicit confirmation without echoing input data.
- Added certified interactive runtime record consumption: execution and computer posture now consume daemon/SDK read models for live process output chunks, typed PTY session routes, sudo credential mediation, and browser/desktop command receipts, surfacing schema/version/publication/publisher/provenance evidence, bounded redacted output, exact confirmed control routes, and missing certification signals without exposing raw secrets or private UI payloads.
- Added Work workspace process supervision: Work & Approvals now shows tracked/running/completed local process counts, stdin/PTY/sudo parity, process monitor/live-tail routes, and visible Background processes / Process capabilities actions.
- Added deep research briefing: `research action:"briefing"` now returns one read-only next-action queue across visible runs, source review, saved report artifacts, browser readiness, and exact follow-up routes without searching, mutating, opening browser surfaces, saving reports, ingesting Knowledge, exporting artifacts, archiving, sharing, or sending messages.
- Improved run-bound source search: `research action:"search" runId:"..."` now uses the visible run's saved question and returns run-specific inspect, briefing, start, and checkpoint follow-up routes without creating, starting, checkpointing, or mutating source records.
- Added cross-project handoff docs for GoodVibes TUI/daemon and GoodVibes SDK so browser-backed research, browser/PWA rendering, Personal Ops provider queues, PTY/sudo/process, watcher history, remote runner evidence, local model health, mobile/voice/device, channel receipts, and external memory provider contracts have concrete acceptance criteria before Agent consumes them.
- Added next-route packets to research run detail and mutation outputs so create/start/checkpoint/pause/resume/cancel/complete/fail/delete results point to the next visible inspect, briefing, workflow, run-bound search, source queue, checkpoint, report save, artifact inspection, or Knowledge promotion route without performing hidden work.
- Added next-route packets to research source detail and mutation outputs so add/review/reject/use/delete results point to the next visible inspect, queue, review/reject, bundle, sourced report save, mark-used, report artifact, or optional Knowledge promotion route while preserving separate confirmation gates.
- Added next-route packets to confirmed research report saves so saved artifacts point to high-level report inspection, artifact export/archive, Knowledge promotion, report listing, and visible run completion when `runId` is provided.
- Added deep research workflow planning: `research action:"plan"` now returns a read-only ordered route plan across visible run state, public web/fetch or browser posture, source capture/review, sourced report saves, and optional artifact-to-Knowledge promotion.
- Added research runner/report contracts: `research action:"runner"` directly exposes browser-runner setup and user-control requirements, while `research action:"plan"` includes those contracts plus visual-report packet sections, citation/source-map acceptance criteria, and artifact archive routes so missing browser execution and browser/PWA report rendering are explicit product gaps rather than hidden assumptions.
- Added certified live research read-model consumption: Research briefing, workflow planning, and run queues now consume SDK/daemon browser-backed runner records and browser/PWA visual report render records with schema/version/publication/publisher/provenance/freshness-cursor/receipt metadata, redacted URLs/logs, source/page receipt ids, visual sections, citation coverage, and exact inspect/open routes.
- Added Research workspace contract visibility: the existing renderer now shows browser-runner and visual-report readiness in the Research area, keeps the direct research run/source/report routes visible, and adds Research briefing, Plan workflow, Public source search, Browser runner readiness, and Report artifacts actions that map directly to `research action:"briefing"`, `research action:"plan"`, `research action:"search"`, `research action:"runner"`, and `research action:"reports"`.
- Added artifact ZIP archive export: `agent_artifacts mode:"archive"` writes the same reviewed package payload as one workspace ZIP file, while the existing package workspace form now lets users choose directory or ZIP output with the same confirmation and redacted manifest policy.
- Added reviewer-ready document export appendices: `agent_documents mode:"export"` now saves comment and AI suggestion summaries plus review metadata counts with the markdown artifact, without printing draft content in the tool response.
- Added reviewer-readiness checks: Document Ops now flags missing source artifacts, unresolved comments, proposed suggestions, unrevealed comparisons, hidden judgments, route-change decisions, and incomplete handoff evidence before export, archive, or model-route apply.
- Added visible reviewer preflight and handoff diff forms: Documents & Compare now has a read-only readiness preflight before export/archive/apply and a split-pane reviewer handoff diff form backed by `agent_model_compare mode:"handoffDiff"` with section jumps for metadata, policy, related artifacts, or comparison evidence.
- Added recent handoff choices in the diff form: Documents & Compare now reads saved reviewer handoff artifact metadata, shows the saved count, pre-fills the newest older-to-newer pair when available, and still lets blank IDs list recent handoffs safely.
- Added inline reviewer-readiness badges: document export, reviewer handoff/archive, and apply-winner forms now show readiness status, issue counts, and the next preflight action at the point of confirmation.
- Added review packet timeline: Documents & Compare and `document_ops_lane` now show one chronological document/comment/suggestion/attachment/export/compare/judgment/handoff/archive packet history with the next route decision.
- Added guided review packet defaults: Documents & Compare now picks the latest packet document/export/comparison/judgment/handoff evidence and pre-fills document export, compare handoff/archive, and apply-winner forms with editable field hints while preserving confirmation gates.
- Added reusable review packet presets: Documents & Compare now has a confirmed Save packet preset form backed by `agent_review_packet_presets`, with local JSON preset artifacts in the packet timeline, list/show reuse routes, and default fallback only when live packet evidence is missing.
- Added review packet preset freshness checks: preset list/show routes and the packet timeline now flag missing or superseded saved artifact ids, and show recommended reuse routes with newer matching evidence when metadata is sufficient.
- Added review packet preset refresh: stale presets can now be refreshed through a confirmed workspace form or `agent_review_packet_presets mode:"refresh"`, saving a new local preset artifact with source-preset lineage instead of making the user copy replacement ids by hand.
- Added review packet wizard: Documents & Compare and `document_ops_lane` now expose a read-only six-step packet guide across draft review, document export, compare judgment, reviewer handoff, route decision, and final archive review with progress, current-step route hints, backtracking routes, and refreshed-preset lineage before sharing.
- Added review packet sharing: Documents & Compare now has a confirmed Share review packet form backed by `agent_review_packet_share`, which validates a saved reviewer handoff archive, previews the configured delivery target and packet evidence ids, and sends only a plain-text archive reference after explicit confirmation.
- Added route-decision receipts: confirmed `agent_model_compare mode:"apply"` now saves an apply-winner receipt artifact, `mode:"routeDecision"` records leave-unchanged decisions without changing model routing, and Document Ops readiness/wizard state clears matching route-decision blockers before archive evidence exists.
- Added route-decision receipt archive evidence: `agent_model_compare mode:"handoffArchive"` now auto-includes matching route-decision receipt artifacts in reviewer handoff ZIP archives, README counts, archive metadata, and redacted manifests.
- Added blind comparison synthesis: `agent_model_compare mode:"synthesis"` groups saved judgment reasons into stable cross-session preference themes, reports revealed/hidden winner posture, and routes through the existing Compare Analytics workspace form without changing model routing.
- Added blind comparison reviewer handoffs: `agent_model_compare mode:"handoff"` creates one confirmed markdown artifact that combines saved comparison or judgment evidence with related document/artifact exports, while the existing Export Compare workspace form can choose report or handoff.
- Added blind comparison handoff archives: `agent_model_compare mode:"handoffArchive"` turns a saved reviewer handoff into one ZIP artifact with the handoff, source comparison or judgment, related evidence bytes, README, and redacted manifest.
- Added side-by-side comparison review: `agent_model_compare mode:"sideBySide"` renders related document/artifact excerpts beside saved comparison or judgment evidence through the existing Review Saved Compare form without creating artifacts or changing routes.
- Added filtered comparison analytics: saved comparison judgments now preserve task type, document id, and benchmark tags so `agent_model_compare mode:"analytics"` and `mode:"synthesis"` can show targeted preference trends without changing routes.
- Added VIBE.md personality support: project/global VIBE.md files are discovered, secret-scanned, injected into the serial Agent prompt, surfaced in the Personas workspace, and manageable through `vibe action:"status|show|init|import_persona"` or `/vibe status|init|show|import-persona`.
- Added project context support: `.hermes.md`, `HERMES.md`, `AGENTS.md`, `CLAUDE.md`, optional `HERMES_HOME/SOUL.md`, `.cursorrules`, and `.cursor/rules/*.mdc` are secret-scanned, injected as project instructions separate from VIBE.md personality, and exposed through `context action:"files|file"` with target-aware subdirectory lookup.
- Surfaced VIBE.md and project context health in the Local Context and Personas workspace: users now see applied/blocked/truncated counts and direct Inspect VIBE.md, Inspect project context, and Inspect one context file actions without knowing harness modes.
- Added managed Agent orchestration cards: `agent_harness mode:"agent_orchestration"` and `mode:"agent_orchestration_agent"` expose live subagent state, serial-by-default policy, multi-agent milestones, per-agent plan cards, remote-runner contract/artifact evidence, spawn/batch-spawn decision cards, templates, and exact first-class `agent` inspect/message/wait/cancel routes without creating hidden work.
- Added confirmed work-plan agent dispatch: `agent_work_plan action:"dispatch_agents"` previews selected approved work-plan items, then calls first-class `agent` spawn or batch-spawn after confirmation and writes linked-agent receipts back to the plan.
- Added post-dispatch next routes for work-plan agent dispatch: successful dispatch output and linked work-plan detail now point directly to orchestration, work-plan, agent inspect/wait/message/cancel, and closeout routes.
- Added orchestration closeout evidence: managed Agent cards now correlate linked work-plan items, dispatch receipt counts, closeout update routes, and remote-runner artifacts auto-attached by runner id with exact review routes.
- Added certified remote-runner read-model evidence: managed Agent cards now consume daemon/SDK live capture/export/closeout outcome records plus workspace/worktree isolation evidence by runner id, with schema/version/publication/publisher/provenance/freshness-cursor/receipt metadata, bounded redacted summaries, missing certification signals, source paths, closeout counts, and review-gate requirements while leaving remote mutations on confirmed routes.
- Added VIBE.md setup and curator health: blocked or truncated project/global personality files now appear in first-run setup and `memory action:"curator|candidate"` cards with `/vibe` inspection, init, and import routes.
- Added VIBE.md profile starter portability: starter export/from-discovered flows can include safe VIBE.md content with `--include-vibe`, imports preserve it, and profile creation writes it into the isolated profile home.
- Added tracked local background process controls: `execution action:"processes|process"`, `terminal command:"..." background:true`, and `process action:"poll|log|wait|kill|write"` expose shared ProcessManager start/list/status/log/wait/stop with bounded redacted output, process monitor/live-tail handoffs, session-id aliases, conditional confirmed stdin-write dispatch when a safe ProcessManager method exists, unsupported PTY guidance, and blocked hidden sudo prompts; lower-level background harness modes remain compatibility routes.
- Added execution history activity cards: `execution action:"history"` groups redacted tool/shell/edit records into user-facing outcome cards with verification evidence, bounded process-output summaries, supervision routes, and file-recovery handoffs, while `execution action:"record"` keeps exact record inspection available.
- Completed connected-host daemon aliases for the model: `daemon` maps to connected-host posture and `daemon_status` maps to live connected-host status while lifecycle control stays outside Agent.
- Completed settings parity for the model-facing harness and then promoted it behind first-class `settings`: discovery is compact by default with per-setting `modelRoute` hints, `settings action:"get"` and `includeParameters:true` expose full descriptors, and `settings action:"set|reset"` use the same config/secret managers with confirmation and external-host setting locks.
- Completed the tool-description verbosity sweep: first-class Agent tools and wrapped built-in tool definitions now register concise descriptions, nested parameter schema descriptions are stripped from the default model-visible catalog, and detailed safety rules remain enforced in policy wrappers, confirmation errors, and detailed harness inspection.
- Completed copyable model route hint cleanup: confirmed harness examples now include the required `confirm:true` and `explicitUserRequest` fields so route hints match the actual execution contract.
- Completed resilient shortcut/keybinding discovery: `agent_harness` returns fixed shortcuts and default-fallback keybinding descriptors when the live keybinding manager is absent, while keybinding execution and mutation still fail closed until the runtime manager is available.
- Completed the model-visible operator method catalog: `agent_harness` can now list and inspect allowlisted public operator and Agent Knowledge methods with their owning first-class model tools, confirmation policy, and boundaries, without exposing arbitrary route invocation.
- Expanded first-class Agent Knowledge reads: `agent_knowledge` now covers status, ask, search, source/node/issue lists, item lookup, map summary, connector list/detail, and connector doctor while staying inside `/api/goodvibes-agent/knowledge/*`.
- Added Agent-owned Knowledge response-scope validation: CLI, model tools, and live verification normalize public Agent-route scope aliases and reject successful-looking payloads with known non-Agent payload markers.
- Expanded release-route enforcement for Agent Knowledge: architecture/package policy now guards the full route catalog, and live verification definitions include source, node, issue, map, and connector read routes in addition to status, ask, and search.
- Verified the release line against connected-host public Agent routes for Agent Knowledge alias scope normalization and telephony channel surface support.
- Renamed active release evidence artifacts to current-release paths under `release/`, including release notes, readiness inventory, performance snapshot, and live-verification reports, so current release metadata no longer depends on stale historical filenames.

## 1.2.0 - 2026-06-07

- Promoted GoodVibes Agent to the stable 1.0.x operator product surface: the fullscreen Agent workspace is the primary TUI, with setup, provider/model routing, status, compatibility, and doctor flows shaped around personal operator use instead of copied host lifecycle controls.
- Completed the Agent-local behavior system for day-one operation: VIBE.md personality, project context files, local memory posture, prompt-active recall, vector/embedding health, notes, personas, skills, skill bundles, routines, starter profiles, discovery/import flows, review/stale/delete controls, and secret-looking content rejection all stay under Agent ownership.
- Completed isolated Agent Knowledge coverage across CLI, slash commands, workspace panels, connector/source/node/issue views, URL/file/browser/connector ingest, semantic ask/search, issue review, packet/explain previews, consolidation, reindex, and connected-host `/api/goodvibes-agent/knowledge/*` routes without fallback to default or non-Agent knowledge surfaces.
- Completed connected-host operator integration without taking host lifecycle ownership: compatibility/status checks, authenticated health and model routes, channel readiness, provider-account posture, approvals, automation snapshots, schedules, work plans, media/voice readiness, pairing, and explicit public-route diagnostics are all visible from Agent.
- Completed explicit side-effect boundaries for personal operation: channel sends, notifications, autonomous schedule creation, schedule enable/disable/delete, routine schedule promotion, reminders, subscription/auth actions, memory bundle imports/exports, support bundles, MCP configuration, profile changes, and build delegation require explicit confirmation where they mutate state or call external routes.
- Added first-class user-task route planning: `route action:"plan|status"` and lower-level `agent_harness mode:"route_decision"` turn a plain request into the preferred visible Agent route, alternatives, missing fields, confirmation boundary, workspace matches, and harness mode matches without running tools or creating hidden work, including screenshot/browser-control requests that now route to `computer action:"plan"`.
- Host/daemon health, doctor, readiness, service, and compatibility requests now route to `host action:"status"` first before setup repair or service lifecycle effects.
- Normal settings/configuration requests now route to `settings action:"list"` first so setting changes start with Agent-owned discovery and explicit confirmation boundaries.
- Direct reminders, schedules, cron, and schedule lifecycle requests now route to `schedule action:"list"` first, while broader ongoing work remains on autonomy intake.
- Plain command-shaped background work now routes to `execution action:"processes"` and the first-class `terminal`/`process` UX, while scheduled or watcher-like background work stays on autonomy intake.
- Interactive terminal, PTY, stdin, and sudo requests now route to `execution action:"process_capabilities"` first so users see current support, setup posture, and confirmation boundaries before any hidden process start or credential effect.
- External memory-provider, backend, cross-session sync, import/export, and named-provider requests now route to `memory action:"provider"` or the external provider checklist before Agent promises provider writes, sync, credentials, or import/export effects; provider detail also exposes next-route packets, missing setup/status/read/write/sync checks, and required receipt fields for SDK/daemon records Agent can consume.
- Model provider, local-cookbook, local server smoke, and route-fit requests now route to `models action:"provider|local|smoke|route"` before Agent attempts credential, smoke, benchmark, or route-change effects.
- Browser-backed research runner requests now route to `research action:"runner"`, and visual research report rendering requests route to `research action:"plan"` plus report artifacts before Agent claims browser/PWA rendering readiness.
- Voice workflow, TTS-provider, browser cockpit, and PWA requests now route to `device action:"voice|provider"` or `computer action:"browser"` before Agent attempts capture, playback, picker, or browser-open effects.
- Personal Ops briefing, saved queue, fresh inbox/calendar read, and connector setup requests now route to `personal_ops action:"briefing|queue|intake|lane"` before Agent attempts live provider reads or effects.
- Channel setup, triage, delivery receipt, and send requests now route to `channels action:"setup|triage|deliveries|channel"` before Agent attempts confirmed external delivery.
- Plain file undo/redo/recovery requests now route to `execution action:"recovery"` so users inspect available snapshots before confirming a local file mutation.
- Media generation requests now route to provider readiness and confirmed `agent_media_generate` saved-artifact output instead of inline bytes or silent Knowledge promotion.
- Permission posture, security finding, and blocked-action questions now route to `security action:"status|finding|explain"` so users get active permission state, exact redacted findings, or read-only policy preflight without knowing security harness mode names.
- Support-bundle, saved-session/bookmark, and release/audit evidence requests now route to first-class read-only `support action:"status|bundle"`, `sessions action:"list|get"`, and `audit action:"readiness|evidence|item|artifact"` before bundle export/import/share, session lifecycle, or audit drill-in effects.
- Added first-class setup repair decisions: `setup action:"repair"` and lower-level `agent_harness mode:"setup_repair"` choose the next safe token repair, connected-host status, services.status receipt, user-run bootstrap, or no lifecycle action without executing lifecycle, token, import, or UI effects.
- Added first-class policy explanations: `security action:"explain"` and lower-level `agent_harness mode:"policy_explain"` show why one model action is allowed, denied, or waiting on confirmation across the Agent route guard, permission mode, and typed tool confirmation, with secret-looking args redacted and no tool execution.
- Added user-first delegation decision cards and structured handoff briefs: execution and delegation posture now distinguish local-first work, TUI handoff, delegated review, remote inspection, and blocked hidden fanout, while `/delegate` and the Agent Workspace form preserve reason, success criteria, workspace hints, priority, and explicit review intent.
- Added the first-class `delegation` tool: `action:"status|routes|route"` exposes delegation policy, route catalogs, and exact confirmed handoff contracts without requiring harness mode names.
- Added the first-class `execution` tool: `action:"status|route|history|record|processes|process_capabilities|process|recovery"` exposes local-vs-delegated work posture, exact route inspection, activity cards, tracked process inspection, direct process parity/doctor reporting, and file recovery without requiring harness mode names.
- Added the first-class `computer` tool: `action:"status|plan|control|browser|setup|mcp|open_browser"` exposes browser/PWA readiness, browser/screenshot/desktop-control route planning, repair/setup rows, trusted MCP/tool discovery, and confirmed browser cockpit opens without requiring harness mode names.
- Added normalized autonomy queue controls: research runs, connected-host tasks, approvals, automation runs, and schedules now expose available/unavailable controls with reasons plus exact confirmed routes for checkpoint, pause, resume, cancel, approve, deny, retry, run, edit, enable, disable, and delete actions; host task cancel/retry stays on confirmed `agent_operator_method` routes while `/tasks` remains inspection-only.
- Added the first-class `autonomy` tool: `action:"intake|queue|item|status"` exposes ongoing-work route selection and visible autonomy queue inspection without requiring harness mode names.
- Added trigger workflow posture: `autonomy action:"intake"` now maps time-based wakeups/schedules, incoming webhook/event watchers through published `watchers.*` daemon routes, Gmail/email connector-gated triggers, and read-only control-plane event streams, with watcher creation kept admin-confirmed and source-scoped.
- Added certified watcher receipts: `autonomy action:"intake"` now exposes watcher success criteria, and `agent_operator_method` summarizes `watchers.create/patch/run/start/stop/delete` receipts into certified or follow-up outcomes without exposing operator tokens.
- Added a source-owned watcher evidence contract: `autonomy action:"intake"` now tells users and models which SDK/daemon-owned durable run-history receipts, provider source records, redacted event payload descriptors, and queue correlation records are needed before Agent claims persisted webhook/Gmail watcher history.
- Added host task output posture: autonomy queue connected-host task records now expose `/tasks output` routes plus bounded redacted result/error previews when the host publishes them, and route-only status when true output text is not in the read model.
- Completed package and release hardening for the release gate: Bun-only install/run instructions, package-facing text verification, package runtime bundling, packed global install smoke, blocked lifecycle command smoke, source/package boundary checks, architecture checks, recorded performance snapshot checks, verification ledger, strict live verification artifacts, and release-quality readiness inventory dimensions are now part of the validated release path.
- Completed the compact model-visible harness pass: `agent_harness` summary now starts with an assistant-first cockpit before technical counters, plural catalogs default to compact rows, `mode:"modes"` searches every harness mode by task/id/effect/parameter, and `mode:"mode"` inspects one mode contract with full schemas, policy blocks, route metadata, editor fields, release artifact detail, redacted log tail, and parameter detail behind `includeParameters:true` or singular inspect modes.
- Added a first-class `workspace` adapter for workspace actions, panels, UI surfaces, slash commands, CLI mirrors, keybindings, and fixed shortcuts, so the model can inspect or confirm visible workspace operations without memorizing harness mode names; lower-level harness modes remain for detailed route inspection and compatibility.
- Added ordered channel setup guide: Agent Workspace -> Channels, `/channels guide`, and `channels action:"setup"` now rank the next channel and walk through setup schema, secret-backed settings, delivery target, allowlist policy, live status/doctor checks, and explicit confirmed test-send boundaries.
- Added channel triage: Agent Workspace -> Channels, `/channels triage`, and `channels action:"triage"` now unify setup blockers, daemon delivery attempts, visible surface messages, route bindings, and redacted Agent receipts without claiming provider-specific unread inbox polling.
- Added channel delivery receipts: confirmed `/channels send` and `agent_channel_send` deliveries now write Agent-owned redacted receipt history, visible through Agent Workspace -> Channels, `/channels deliveries`, and `channels action:"deliveries"`.
- Added route-backed browser and desktop control setup posture: `setup action:"status|item"` plus `execution action:"status|route"` now show ready, attention, or setup-needed state, workflow cards, setup checklists, fallback routes, and MCP review routes for browser, desktop, computer-use, screenshot, or screen-recording tooling; lower-level `setup_posture`, `setup_item`, `execution_posture`, and `execution_route` remain compatibility routes.
- Added connected browser cockpit routing: Home, `computer action:"browser|open_browser"`, `workspace action:"surface|open"`, and lower-level UI surface detail routes now expose the configured connected-host browser cockpit/PWA URL with service/web setup fallback, workspace-category coverage, mobile/PWA controls, Agent onboarding marker status, and an honest unpublished browser/PWA first-run receipt contract.
- Added companion device capability mapping: `device action:"status|capability"` and lower-level `pairing_posture` / `pairing_route pairingRouteId:"device-capability-map"` now show ready/attention/setup-needed/not-published posture for companion pairing, mobile command routing, browser/PWA, voice controls, spoken responses, notifications, browser/desktop control, and camera/location sensors without returning raw tokens or claiming unpublished device APIs.
- Added voice workflow posture: `device action:"voice"` and lower-level `media_posture` now map push-to-talk input, voice memo transcription, spoken responses, and wake-word capture with ready/attention/setup-needed/not-published state, setup routes, runtime evidence, and explicit policy that always-listening capture is not published yet.
- Surfaced voice/device/browser posture in Voice & Media: the workspace now has Voice workflows, Device capability map, and Browser/PWA readiness actions with direct `device` and `computer` route hints.
- Added sudo execution posture: `execution action:"status|route"`, `setup action:"status"`, `setup action:"item" setupItemId:"sudo-execution-posture"`, and `process action:"capabilities"` now expose foreground-supervised escalation guidance, SUDO_PASSWORD presence-only status, blocked background sudo/stdin password routes, and missing SDK/daemon mediation contracts without reading or printing raw password values.
- Added connected-host setup repair cards: expanded `setup_posture` and `setup_item` rows now expose status/service diagnostics plus confirmed service install/start/restart `agent_operator_method` routes when the SDK operator contract supports them, while first-run setup excludes service stop/uninstall.
- Added probe-fed setup repair recommendations: connected-host setup now includes live service probe evidence, recommends diagnostics/status first, and keeps service install/start/restart as inspect-first confirmed routes until service status proves they are needed.
- Added certified service repair receipts: setup repair cards now include success criteria and verification routes, and `agent_operator_method` summarizes services.status/install/start/restart receipts into certified or follow-up outcomes without exposing the operator token.
- Added service lifecycle receipt decisions: setup posture now exposes serviceLifecycleDecision gates, and `agent_operator_method methodId:"services.status"` maps returned installed/running/control-plane evidence to exact install, start, restart, or no-action guidance before any lifecycle mutation.
- Added connected-host auth setup posture: first-run setup now has a token-safe connected-host auth row for missing/usable operator token state, fingerprint-only token evidence, `/auth review` guidance, exact pairing route ids, confirmed SDK-backed local token create/repair, and regression fixtures for missing-host, reachable-host, missing-token, and unconfigured-model setup paths.
- Added setup smoke execution: first-run setup now includes a token-safe install smoke row plus confirmed `setup action:"smoke"` evidence collection from package binary/version/status to connected-host status, auth posture, provider/model routing, setup posture, one first assistant turn, optional saved redacted evidence artifacts, and Home/setup latest-result plus history/trend/frequent-blocker surfacing without running shell commands implicitly.
- Added guided setup wizard: the Start workspace and `setup_posture` now expose progress, current-step routes, backtracking routes, setup-smoke rerun/save routes, and repeated-blocker focus from saved smoke evidence so first-run repair feels like one guided flow instead of a loose checklist.
- Added saved setup wizard checkpoints: Start and `setup action:"status"` now show the saved resume state, stale checkpoint auto-advance evidence, Start show/save/clear checkpoint actions, and `setup action:"checkpoint|save_checkpoint|clear_checkpoint"` inspect or mutate only Agent-owned step resume metadata after confirmation.
- Added setup closeout: Start and `setup action:"status"` now expose `setupWizard.closeout` / `setupCloseout` decisions that reduce critical setup blockers, saved setup smoke evidence, and the user onboarding completion marker into blocked, needs-smoke-evidence, ready-to-finish, or complete states; confirmed `setup action:"finish"` writes only the user onboarding markers.
- Added first-run local model readiness: `setup action:"status"` and `setup action:"item"` now include a local-model readiness row with detected local stacks/routes, top cookbook recipe, readiness score, benchmark follow-through, and exact model-routing inspect routes.
- Added Personal Ops connector tool classification: expanded inbox and calendar lanes now read MCP tool metadata when available, classify read-only versus write-like email/calendar tools, and carry those capability tags into connector records and workflow prerequisites.
- Added Personal Ops schema-derived operation records: expanded inbox and calendar lanes now turn reviewed MCP schemas into required-field/sample-input/schema-route cards with explicit confirmation flags for send/edit-like actions.
- Added Personal Ops execution plans: request intake now returns ordered connector-read, local-compose, setup-repair, and confirmed-effect steps so inbox/calendar work is legible before any live provider action.
- Added confirmed Personal Ops read execution: `personal_ops action:"read"` (backed by `run_personal_ops_read`) runs one selected read-only inbox/calendar MCP operation after required-field and confirmation checks, refuses write-like tools, and returns bounded redacted output plus normalized review cards; users can also request a saved redacted review-card artifact without storing full raw connector output or full input values.
- Added next-route packets to confirmed Personal Ops reads so refreshed reads, lane/queue inspection, saved artifact reopen, local reply/reminder drafting, and send/calendar-edit boundaries are explicit structured routes after one read completes.
- Added Personal Ops saved review queues: saved inbox/calendar review artifacts now resurface as redacted thread/event queue records with artifact inspect routes, freshness status, confirmed refresh routes when a matching read connector is ready, local draft/reminder follow-up routes, and explicit confirmed provider-effect boundaries.
- Added the direct Personal Ops review queue: `personal_ops action:"queue"` aggregates saved inbox thread/calendar event review items, fresh provider-read routes, refresh routes, and follow-up confirmation boundaries without executing MCP tools or mutating artifacts.
- Added Personal Ops task/reminder workflows: task lanes now separate visible work-plan actions from connected-host task inspection/control, and reminder lanes now expose confirmed reminder creation, autonomous schedule creation, schedule review, run, pause/resume, and exact-id control records.
- Added Personal Ops daily briefings: `personal_ops action:"briefing"` and the visible Daily briefing plan action now assemble one read-only user-first plan across inbox, agenda, tasks, reminders, routines, delivery, notes, and autonomy queue before any live personal-data read or effect.
- Added the first-class `personal_ops` adapter: `action:"briefing|status|queue|intake|lane"` exposes the safe Personal Ops discovery flow directly, while confirmed `action:"read"` preserves the existing one-operation inbox/calendar read boundary with required fields, redaction, and optional saved review cards.
- Added research runner posture: `research_runs` now exposes browser-backed research readiness, setup and fallback routes, source review, report save, Knowledge promotion routes, and policy so deep research requests do not pretend browser execution is ready when only web/fetch research is available.
- Added visual research report packets: `research action:"report" visualReport:true` now appends at-a-glance, evidence matrix, findings board, dated source/comparison, open-question, next-action, and handoff-checklist sections to the saved sourced artifact while preserving citation coverage metadata and no transcript body dump.
- Added guided learning consolidation execution: `memory action:"curator"` now returns an ordered duplicate-consolidation batch plan and first-class `agent_learning_consolidation` preview/merge/stale/delete/rollback/recreate routes; merge and stale phases write durable receipts, delete refuses duplicates that have not been staged stale, post-delete receipts preserve snapshots with exact-id recreate guidance, and confirmed recreate refuses unsafe id collisions before restoring deleted duplicates.
- Added learning prompt plans: `memory action:"curator"` now returns prompt-active records, suppressed review/setup/low-confidence/personality/consolidation counts, proposal queues, consolidation queues, and usefulness/freshness/source-quality/risk ordering rules so users and the model can see what may guide the assistant now before durable context expands.
- Added prompt context inspection and receipts: prompt builds now write durable sanitized receipt ids with turn/source/model/provider, selected and suppressed record refs, segment counts, prompt hash, size, timestamp, and completed/error/cancelled outcome without storing raw prompt or response text; Agent Workspace -> Local Context shows a compact receipt outcome timeline with exact latest-receipt drill-in and outcome filter routes, and `context action:"prompt|receipts|receipt"` exposes recent receipts, exact `receiptId`/`turnId`/`outcomeStatus` filters, turn outcomes, applied prompt composition order, selected VIBE.md/project context/memory/routine/skill/persona records, suppressed records, prompt previews on request, and approximate token budget without mutating local behavior.
- Added missing-host setup bootstrap: `setup action:"item"` for connected-host readiness now returns user-run GoodVibes host install, trust, binary verification, service start, and Agent reconnect commands before operator methods are reachable.
- Added first-class model/provider routing: `models action:"status|route|local|providers|provider|smoke"` now fronts model route readiness, provider/subscription posture, local model cookbook, exact route/provider lookup, and confirmed local server smoke checks while lower-level harness modes remain available for detail.
- Added model readiness scoring: `model_routing`, `model_route`, and the local model cookbook now expose estimated 0-100 readiness across latency, context window, tool support, vision, cost, and privacy while clearly flagging missing live benchmarks; the visible Model Routing lane now has an `Inspect route readiness` action for that read-only posture.
- Added local server endpoint checks: the local model cookbook now maps detected local provider/model registry endpoints and local base URL environment hints into exact endpoint inspect routes, model-list smoke commands, success criteria, failure triage, confirmed `models action:"smoke"` checks for detected or default local endpoints, refresh routes, provider-add hints, suggested defaults, and a visible `Check local servers` workspace action without running a hidden network probe.
- Added local model benchmark execution and evidence: the Model Routing workspace now includes a confirmed local benchmark action backed by `agent_model_compare` with `benchmarkKind:"local-model-route"` plus a `Review benchmark evidence` action for saved comparisons, revealed winner judgments, and filtered analytics before any separate default-model apply action.
- Added the visible assistant cockpit to TUI Home: the existing renderer now opens on the same setup, chat/model, project work, Personal Ops, research/docs, background supervision, and safety/recovery lanes as `agent_harness mode:"summary"`, while deeper subsystem details stay in categories and search.
- Tightened local behavior prompt quality gates: reviewed memory now requires the durable confidence threshold, and skills, routines, bundles, and personas only steer the assistant when reviewed and setup-ready; suppressed behavior remains visible as review/setup work.
- Added memory posture UX: `memory action:"status|provider|list|search|get"` now exposes Agent-local memory counts, direct record lookup/search, prompt-active recall, vector stats, embedding-provider doctor warnings, provider inspection, and external-memory setup contract maps for Honcho, OpenViking, Mem0, Hindsight, Holographic, RetainDB, ByteRover, and Supermemory, including provider-specific next routes, missing setup/status/read/write/sync checklist items, and required sync/write receipt fields while honestly marking provider records as not published until the SDK/daemon exposes concrete setup/status/read/write/receipt records for Agent to consume.
- Added background-process parity reporting: `process action:"capabilities"` now maps terminal background start plus process list/poll/wait/log/kill/write, PTY, and sudo semantics to supported routes or explicit SDK/daemon contract gaps, with lower-level lifecycle aliases still accepted for compatibility.
- Improved background process logs: `execution action:"process"` and `process action:"log"` now return redacted stdout/stderr tails with byte counts, character counts, truncation flags, and direct process-style routes.
- Added first-class terminal/process adapters: `terminal command:"..." background:true` starts a visible tracked local process, while `process action:"list|poll|wait|log|kill|write"` manages the same ProcessManager records with the existing confirmation and unsupported PTY/stdin/sudo boundaries.
- Added a first-class schedule adapter: `schedule action:"list|create|remind|edit|run|pause|resume|delete"` routes recurring work, reminders, exact schedule edits, and lifecycle controls through the existing preview, confirmation, current-state diff, and allowlisted connected-host schedule paths.
- Added post-action next routes for schedules: confirmed autonomous schedule creation, routine promotion, reminders, schedule edits, and schedule lifecycle controls now return schedule list, autonomy queue, run, edit, pause, resume, and delete routes without weakening confirmation gates.
- Added pre-confirmation schedule handoffs: autonomous schedule, reminder, routine-promotion, and schedule-edit previews now include explicit confirmation routes while remaining non-mutating.
- Added a first-class setup adapter: `setup action:"status|item|repair|checkpoint|save_checkpoint|clear_checkpoint|token|smoke|finish|import_settings"` gives first-run setup a short user-intent route while delegating to the existing wizard, repair decision, token, smoke, closeout, and settings-import implementations.
- Added a first-class VIBE.md adapter: `vibe action:"status|show|init|import_persona"` gives personality setup a short user-intent route while preserving secret scans, confirmation gates, and Agent-local persona boundaries; unconfirmed init/import previews now include exact model and CLI `confirmationRoutes`.
- Added a first-class settings adapter: `settings action:"list|get|set|reset|import"` fronts Agent settings and GoodVibes settings import preview/apply without requiring the model to know harness settings modes or the workspace action id.
- Shared GoodVibes settings import previews now include source-package ownership metadata so users can reuse goodvibes-tui or other published GoodVibes platform settings without Agent mutating source package stores.
- Added a first-class host adapter: `host action:"status|capabilities|capability|services|service|methods|method"` fronts connected-host status, capability maps, service posture, endpoint detail, and daemon method inspection while preserving exact execution on `agent_operator_method`.
- Added a first-class device adapter: `device action:"status|capability|browser|control|voice|provider|open_browser|open_tts_provider|open_tts_voice"` keeps companion, mobile/PWA compatibility, voice/TTS, browser/desktop-control compatibility, provider posture, and visible browser/TTS picker handoffs available while preserving confirmation gates; `computer` is now the primary browser/PWA and desktop-control route.
- Added a first-class research adapter: `research action:"briefing|plan|search|runner|runs|run|sources|source|bundle|reports|report_artifact|create_run|start_run|checkpoint|pause|resume|cancel|complete|fail|delete_run|add_source|review_source|reject_source|use_source|delete_source|report"` gives deep research one user-facing route over a read-only next-action queue, workflow planning, bounded public source-candidate search, browser-runner readiness, visible run lifecycle, source triage, reviewed-source bundles, saved report inspection, and sourced report artifacts while preserving existing confirmation gates.
- Added dynamic background-process capability probing: the process parity report now detects ProcessManager stdin/PTY methods, terminal/PTY operator methods, GoodVibes session-input routes, and credential routes, and `processAction:"write"` dispatches through a discovered safe ProcessManager stdin method only after explicit confirmation without echoing input data.
- Added Work workspace process supervision: Work & Approvals now shows tracked/running/completed local process counts, stdin/PTY/sudo parity, process monitor/live-tail routes, and visible Background processes / Process capabilities actions.
- Added deep research briefing: `research action:"briefing"` now returns one read-only next-action queue across visible runs, source review, saved report artifacts, browser readiness, and exact follow-up routes without searching, mutating, opening browser surfaces, saving reports, ingesting Knowledge, exporting artifacts, archiving, sharing, or sending messages.
- Improved run-bound source search: `research action:"search" runId:"..."` now uses the visible run's saved question and returns run-specific inspect, briefing, start, and checkpoint follow-up routes without creating, starting, checkpointing, or mutating source records.
- Added cross-project handoff docs for GoodVibes TUI/daemon and GoodVibes SDK so browser-backed research, browser/PWA rendering, Personal Ops provider queues, PTY/sudo/process, watcher history, remote runner evidence, local model health, mobile/voice/device, channel receipts, and external memory provider contracts have concrete acceptance criteria before Agent consumes them.
- Added next-route packets to research run detail and mutation outputs so create/start/checkpoint/pause/resume/cancel/complete/fail/delete results point to the next visible inspect, briefing, workflow, run-bound search, source queue, checkpoint, report save, artifact inspection, or Knowledge promotion route without performing hidden work.
- Added next-route packets to research source detail and mutation outputs so add/review/reject/use/delete results point to the next visible inspect, queue, review/reject, bundle, sourced report save, mark-used, report artifact, or optional Knowledge promotion route while preserving separate confirmation gates.
- Added next-route packets to confirmed research report saves so saved artifacts point to high-level report inspection, artifact export/archive, Knowledge promotion, report listing, and visible run completion when `runId` is provided.
- Added deep research workflow planning: `research action:"plan"` now returns a read-only ordered route plan across visible run state, public web/fetch or browser posture, source capture/review, sourced report saves, and optional artifact-to-Knowledge promotion.
- Added research runner/report contracts: `research action:"runner"` directly exposes browser-runner setup and user-control requirements, while `research action:"plan"` includes those contracts plus visual-report packet sections, citation/source-map acceptance criteria, and artifact archive routes so missing browser execution and browser/PWA report rendering are explicit product gaps rather than hidden assumptions.
- Added Research workspace contract visibility: the existing renderer now shows browser-runner and visual-report readiness in the Research area, keeps the direct research run/source/report routes visible, and adds Research briefing, Plan workflow, Public source search, Browser runner readiness, and Report artifacts actions that map directly to `research action:"briefing"`, `research action:"plan"`, `research action:"search"`, `research action:"runner"`, and `research action:"reports"`.
- Added artifact ZIP archive export: `agent_artifacts mode:"archive"` writes the same reviewed package payload as one workspace ZIP file, while the existing package workspace form now lets users choose directory or ZIP output with the same confirmation and redacted manifest policy.
- Added reviewer-ready document export appendices: `agent_documents mode:"export"` now saves comment and AI suggestion summaries plus review metadata counts with the markdown artifact, without printing draft content in the tool response.
- Added reviewer-readiness checks: Document Ops now flags missing source artifacts, unresolved comments, proposed suggestions, unrevealed comparisons, hidden judgments, route-change decisions, and incomplete handoff evidence before export, archive, or model-route apply.
- Added visible reviewer preflight and handoff diff forms: Documents & Compare now has a read-only readiness preflight before export/archive/apply and a split-pane reviewer handoff diff form backed by `agent_model_compare mode:"handoffDiff"` with section jumps for metadata, policy, related artifacts, or comparison evidence.
- Added recent handoff choices in the diff form: Documents & Compare now reads saved reviewer handoff artifact metadata, shows the saved count, pre-fills the newest older-to-newer pair when available, and still lets blank IDs list recent handoffs safely.
- Added inline reviewer-readiness badges: document export, reviewer handoff/archive, and apply-winner forms now show readiness status, issue counts, and the next preflight action at the point of confirmation.
- Added review packet timeline: Documents & Compare and `document_ops_lane` now show one chronological document/comment/suggestion/attachment/export/compare/judgment/handoff/archive packet history with the next route decision.
- Added guided review packet defaults: Documents & Compare now picks the latest packet document/export/comparison/judgment/handoff evidence and pre-fills document export, compare handoff/archive, and apply-winner forms with editable field hints while preserving confirmation gates.
- Added reusable review packet presets: Documents & Compare now has a confirmed Save packet preset form backed by `agent_review_packet_presets`, with local JSON preset artifacts in the packet timeline, list/show reuse routes, and default fallback only when live packet evidence is missing.
- Added review packet preset freshness checks: preset list/show routes and the packet timeline now flag missing or superseded saved artifact ids, and show recommended reuse routes with newer matching evidence when metadata is sufficient.
- Added review packet preset refresh: stale presets can now be refreshed through a confirmed workspace form or `agent_review_packet_presets mode:"refresh"`, saving a new local preset artifact with source-preset lineage instead of making the user copy replacement ids by hand.
- Added review packet wizard: Documents & Compare and `document_ops_lane` now expose a read-only six-step packet guide across draft review, document export, compare judgment, reviewer handoff, route decision, and final archive review with progress, current-step route hints, backtracking routes, and refreshed-preset lineage before sharing.
- Added review packet sharing: Documents & Compare now has a confirmed Share review packet form backed by `agent_review_packet_share`, which validates a saved reviewer handoff archive, previews the configured delivery target and packet evidence ids, and sends only a plain-text archive reference after explicit confirmation.
- Added route-decision receipts: confirmed `agent_model_compare mode:"apply"` now saves an apply-winner receipt artifact, `mode:"routeDecision"` records leave-unchanged decisions without changing model routing, and Document Ops readiness/wizard state clears matching route-decision blockers before archive evidence exists.
- Added route-decision receipt archive evidence: `agent_model_compare mode:"handoffArchive"` now auto-includes matching route-decision receipt artifacts in reviewer handoff ZIP archives, README counts, archive metadata, and redacted manifests.
- Added blind comparison synthesis: `agent_model_compare mode:"synthesis"` groups saved judgment reasons into stable cross-session preference themes, reports revealed/hidden winner posture, and routes through the existing Compare Analytics workspace form without changing model routing.
- Added blind comparison reviewer handoffs: `agent_model_compare mode:"handoff"` creates one confirmed markdown artifact that combines saved comparison or judgment evidence with related document/artifact exports, while the existing Export Compare workspace form can choose report or handoff.
- Added blind comparison handoff archives: `agent_model_compare mode:"handoffArchive"` turns a saved reviewer handoff into one ZIP artifact with the handoff, source comparison or judgment, related evidence bytes, README, and redacted manifest.
- Added side-by-side comparison review: `agent_model_compare mode:"sideBySide"` renders related document/artifact excerpts beside saved comparison or judgment evidence through the existing Review Saved Compare form without creating artifacts or changing routes.
- Added filtered comparison analytics: saved comparison judgments now preserve task type, document id, and benchmark tags so `agent_model_compare mode:"analytics"` and `mode:"synthesis"` can show targeted preference trends without changing routes.
- Added VIBE.md personality support: project/global VIBE.md files are discovered, secret-scanned, injected into the serial Agent prompt, surfaced in the Personas workspace, and manageable through `vibe action:"status|show|init|import_persona"` or `/vibe status|init|show|import-persona`.
- Added project context support: `.hermes.md`, `HERMES.md`, `AGENTS.md`, `CLAUDE.md`, optional `HERMES_HOME/SOUL.md`, `.cursorrules`, and `.cursor/rules/*.mdc` are secret-scanned, injected as project instructions separate from VIBE.md personality, and exposed through `context action:"files|file"` with target-aware subdirectory lookup.
- Surfaced VIBE.md and project context health in the Local Context and Personas workspace: users now see applied/blocked/truncated counts and direct Inspect VIBE.md, Inspect project context, and Inspect one context file actions without knowing harness modes.
- Added managed Agent orchestration cards: `agent_harness mode:"agent_orchestration"` and `mode:"agent_orchestration_agent"` expose live subagent state, serial-by-default policy, multi-agent milestones, per-agent plan cards, remote-runner contract/artifact evidence, spawn/batch-spawn decision cards, templates, and exact first-class `agent` inspect/message/wait/cancel routes without creating hidden work.
- Added confirmed work-plan agent dispatch: `agent_work_plan action:"dispatch_agents"` previews selected approved work-plan items, then calls first-class `agent` spawn or batch-spawn after confirmation and writes linked-agent receipts back to the plan.
- Added post-dispatch next routes for work-plan agent dispatch: successful dispatch output and linked work-plan detail now point directly to orchestration, work-plan, agent inspect/wait/message/cancel, and closeout routes.
- Added orchestration closeout evidence: managed Agent cards now correlate linked work-plan items, dispatch receipt counts, closeout update routes, and remote-runner artifacts auto-attached by runner id with exact review routes.
- Added VIBE.md setup and curator health: blocked or truncated project/global personality files now appear in first-run setup and `memory action:"curator|candidate"` cards with `/vibe` inspection, init, and import routes.
- Added VIBE.md profile starter portability: starter export/from-discovered flows can include safe VIBE.md content with `--include-vibe`, imports preserve it, and profile creation writes it into the isolated profile home.
- Added tracked local background process controls: `execution action:"processes|process"`, `terminal command:"..." background:true`, and `process action:"poll|log|wait|kill|write"` expose shared ProcessManager start/list/status/log/wait/stop with bounded redacted output, process monitor/live-tail handoffs, session-id aliases, conditional confirmed stdin-write dispatch when a safe ProcessManager method exists, unsupported PTY guidance, and blocked hidden sudo prompts; lower-level background harness modes remain compatibility routes.
- Added execution history activity cards: `execution action:"history"` groups redacted tool/shell/edit records into user-facing outcome cards with verification evidence, bounded process-output summaries, supervision routes, and file-recovery handoffs, while `execution action:"record"` keeps exact record inspection available.
- Completed connected-host daemon aliases for the model: `daemon` maps to connected-host posture and `daemon_status` maps to live connected-host status while lifecycle control stays outside Agent.
- Completed settings parity for the model-facing harness and then promoted it behind first-class `settings`: discovery is compact by default with per-setting `modelRoute` hints, `settings action:"get"` and `includeParameters:true` expose full descriptors, and `settings action:"set|reset"` use the same config/secret managers with confirmation and external-host setting locks.
- Completed the tool-description verbosity sweep: first-class Agent tools and wrapped built-in tool definitions now register concise descriptions, nested parameter schema descriptions are stripped from the default model-visible catalog, and detailed safety rules remain enforced in policy wrappers, confirmation errors, and detailed harness inspection.
- Completed copyable model route hint cleanup: confirmed harness examples now include the required `confirm:true` and `explicitUserRequest` fields so route hints match the actual execution contract.
- Completed resilient shortcut/keybinding discovery: `agent_harness` returns fixed shortcuts and default-fallback keybinding descriptors when the live keybinding manager is absent, while keybinding execution and mutation still fail closed until the runtime manager is available.
- Completed the model-visible operator method catalog: `agent_harness` can now list and inspect allowlisted public operator and Agent Knowledge methods with their owning first-class model tools, confirmation policy, and boundaries, without exposing arbitrary route invocation.
- Expanded first-class Agent Knowledge reads: `agent_knowledge` now covers status, ask, search, source/node/issue lists, item lookup, map summary, connector list/detail, and connector doctor while staying inside `/api/goodvibes-agent/knowledge/*`.
- Added Agent-owned Knowledge response-scope validation: CLI, model tools, and live verification normalize public Agent-route scope aliases and reject successful-looking payloads with known non-Agent payload markers.
- Expanded release-route enforcement for Agent Knowledge: architecture/package policy now guards the full route catalog, and live verification definitions include source, node, issue, map, and connector read routes in addition to status, ask, and search.
- Verified the release line against connected-host public Agent routes for Agent Knowledge alias scope normalization and telephony channel surface support.
- Renamed active release evidence artifacts to current-release paths under `release/`, including release notes, readiness inventory, performance snapshot, and live-verification reports, so current release metadata no longer depends on stale historical filenames.

## 1.1.7 - 2026-06-05

- Hardened the Agent model tool surface so goodvibes_context routes to the Agent harness instead of dead-ending.
- Added tool execution and permission safety guards so registered model tools return structured failures instead of aborting turns.
- Added `route action:"plan|status"` and `agent_harness mode:"route_decision"` for read-only user-task route planning across visible Agent surfaces.
- Routed host/daemon health, doctor, readiness, service, and compatibility wording through `host action:"status"` before setup repair or service lifecycle effects.
- Routed normal settings/configuration wording through `settings action:"list"` so set/reset/import requests start with Agent-owned setting discovery and explicit confirmation boundaries.
- Routed model provider, local-cookbook, local server smoke, and route-fit wording through `models action:"provider|local|smoke|route"` before credential, smoke, benchmark, or route-change effects.
- Routed direct reminder, schedule, cron, and schedule lifecycle wording through `schedule action:"list"` plus confirmed schedule actions, while broader ongoing work remains on autonomy intake.
- Added a source-owned watcher evidence contract to autonomy intake so durable run-history receipts, provider source records, redacted event payload descriptors, and queue correlation stay explicit SDK/daemon handoff requirements instead of hidden Agent assumptions.
- Routed Personal Ops briefing, saved queue, fresh inbox/calendar read, and connector setup wording through `personal_ops action:"briefing|queue|intake|lane"` before live provider reads or effects.
- Added `setup action:"repair"` and `agent_harness mode:"setup_repair"` for read-only setup repair decisions that choose token repair, host status, services.status receipt, user-run bootstrap, or no lifecycle action without executing effects.
- Added `execution action:"capabilities|process_capabilities"` so process parity, PTY, stdin, and sudo posture reports are reachable from the first-class execution tool.
- Added `computer action:"plan"` and `agent_harness mode:"browser_control_route"` for read-only browser navigation, screenshot, and desktop-control workflow routing; `route action:"plan"` now prefers that computer planner for screenshot, browser-control, screen-observation, and desktop-control wording.
- Routed command-shaped background work through local process supervision so `route action:"plan"` prefers `execution action:"processes"` plus first-class `terminal`/`process` controls instead of delegation or autonomy for local long-running commands.
- Routed interactive terminal, PTY, stdin, and sudo wording through `execution action:"process_capabilities"` so unsupported interactive routes are explained before any hidden process start or credential effect.
- Routed external memory-provider, backend, cross-session sync, import/export, and named-provider wording through `memory action:"provider"` or the external provider checklist before promising provider writes, sync, credentials, or import/export effects.
- Added provider-specific next routes, missing setup/status/read/write/sync checklist items, and required receipt fields to the external memory-provider posture so Agent can explain exactly what SDK/daemon records are missing before provider-backed memory is used.
- Clarified shared GoodVibes settings import with source-package ownership metadata so imports remain user-controlled without implying Agent owns the source package capability.
- Routed browser-backed research runner wording through `research action:"runner"` and visual research report rendering wording through `research action:"plan"` plus report artifacts before claiming browser/PWA rendering readiness.
- Routed voice workflow, TTS-provider, browser cockpit, and PWA wording through `device action:"voice|provider"` or `computer action:"browser"` before capture, playback, picker, or browser-open effects.
- Routed channel setup, triage, delivery receipts, and send wording through `channels action:"setup|triage|deliveries|channel"` before confirmed external delivery.
- Routed file undo/redo/recovery wording through `execution action:"recovery"` so plain repair requests inspect FileUndoManager snapshots before any confirmed undo or redo is applied.
- Routed media generation wording through provider readiness and confirmed `agent_media_generate` saved-artifact output so generated bytes stay out of transcripts and Knowledge unless explicitly promoted.
- Routed permission posture, security findings, and blocked-action questions through `security action:"status|finding|explain"` so users can ask what is active, what happened, or why something was blocked without knowing policy tool names.
- Added direct read-only `support`, `sessions`, and `audit` adapters, and routed support-bundle, saved-session/bookmark, and release/audit evidence wording through `support action:"status|bundle"`, `sessions action:"list|get"`, and `audit action:"readiness|evidence|item|artifact"` before export/import/share, session lifecycle, or audit drill-in effects.
- Added `security action:"explain"` and `agent_harness mode:"policy_explain"` for read-only allowed/denied/confirmation-required policy explanations.
- Added registered-tool smoke coverage for the Agent-guarded platform tool roster.

## 1.1.6 - 2026-06-05

- Fixed Import GoodVibes settings so it also imports active and pending provider subscriptions from the GoodVibes TUI user store into Agent-owned subscription state.
- Preserved existing Agent-only subscriptions while merging imported provider sessions by provider id.
- Updated onboarding copy and added regression coverage for subscription import.

## 1.1.5 - 2026-06-05

- Replaced onboarding with the real Agent setup flow for subscription login, provider/model selection, settings persistence, channels, voice, local context, automation, and finish.
- Exposed remaining provider, auth, subscription, and model catalog actions through reachable Agent workspace rows and model-facing harness metadata.
- Split oversized workspace modules so the release architecture gate passes without changing onboarding behavior.

## 1.1.4 - 2026-06-05

- Rebuilt first-run onboarding into actionable Account & Model, Assistant Behavior, Tools & Permissions, Interface, Messaging, Voice & Phone, Context, Verify, and Finish pages with persisted setting actions instead of inert links.
- Added GoodVibes TUI settings import plus conditional channel, telephony, model, permission, display, behavior, voice, and local-context setup rows that write Agent-owned config and saved settings.
- Cleaned the model-facing Agent workspace surface with compact summaries, complete workspace action catalog exposure, unique action and category labels, and unambiguous canonical memory lookup.
- Fixed full-suite temp isolation so exec-tool tests stay stable when other tests clean project temp workspaces.

## 1.1.3 - 2026-06-05

- Add telephony channel support through the updated Agent platform dependency.
- Keep Agent Knowledge scope alias normalization inside Agent CLI, model tools, and live verification while preserving fail-closed non-Agent contamination checks.

## 1.1.2 - 2026-06-05

- Remove the redundant Finish action so onboarding completion presents only Apply & close.

## 1.1.1 - 2026-06-05

- Fix first-run onboarding so clean launches open the fullscreen setup workspace until the user explicitly chooses Finish -> Apply & close.

## 1.1.0 - 2026-06-05

- Add a final onboarding Finish category with Apply & close completion that saves the user onboarding marker and keeps future normal launches in the main conversation.

## 1.0.44 - 2026-06-05

- Compact Agent workspace top-pane copy across every category so the fullscreen onboarding surface keeps settings and actions visible.

## 1.0.43 - 2026-06-05

- Keep the Agent Home and Setup workspace top pane compact so setup actions stay visible.
- Replace noisy setup checklist route text with a concise setup overview and selected-action detail.
- Add renderer coverage for compact setup layout and removed arrow-style checklist output.

## 1.0.42 - 2026-06-05

- Make /agent the sole fullscreen Agent workspace for setup and onboarding entrypoints.
- Route /setup, /onboarding, first-run startup, and model-visible UI surface metadata to plain /agent.
- Remove obsolete onboarding modal renderer and controller paths.

## 1.0.41 - 2026-06-04

- Fixed Agent setup onboarding so the settings-style fullscreen workspace forces a complete terminal redraw and covers the shell input/status rows on packaged installs.
- Hardened terminal size detection so fullscreen shell surfaces use getWindowSize or environment dimensions before falling back.

## 1.0.40 - 2026-06-04

- Onboarding now uses a dedicated fullscreen workspace renderer copied from the settings-style workspace, so setup can be tuned without changing Settings, MCP, or Agent workspaces.
- First-run setup keeps the settings-style left rail, detail pane, field pane, and footer while the shell gives it the full terminal height, hiding the prompt/input area until setup is complete.

## 1.0.39 - 2026-06-04

- Removed the body-scoped onboarding overlay fallback so onboarding can only render through the shell fullscreen composite.
- Added regression coverage for the fullscreen onboarding composite and nested model workspace composite.

## 1.0.38 - 2026-06-04

- Onboarding now uses the shared fullscreen workspace surface so it owns the full terminal height, including the composer area.
- Fullscreen composition now clears stale shell footer rows when overlays replace the normal prompt surface.

## 1.0.37 - 2026-06-04

- Onboarding setup now renders full-bleed across the terminal with no inset edge.
- The Agent workspace rail now uses shared, meaningful section groups instead of one header per workspace.

## 1.0.36 - 2026-06-04

- Workspace navigation now uses distinct category group names instead of repeated setup headings.
- Onboarding now owns the full terminal viewport and blocks composer-adjacent overlays while setup is active.
- Onboarding renderer coverage now guards the bottom row so the setup flow cannot leave the input area visually available.

## 1.0.35 - 2026-06-04

- Added searchable `agent_harness` mode discovery: `mode:"modes"` searches every harness mode by task, family, effect type, id, alias, and parameter name, while `mode:"mode"` inspects one mode contract.
- Added full harness mode descriptors for every model-visible harness operation, with compact summaries, families, effect/read-only classification, confirmation flags, aliases, parameter names, and next-step guidance.
- Compacted registered model tool definitions at runtime: Agent tools now use concise descriptions, generic tool descriptions are capped, and nested JSON-schema descriptions are stripped from the default model-visible catalog while detailed contracts stay inspectable through harness modes.
- Counted the model-visible harness mode catalog in the verification ledger and package metadata gate so release evidence tracks the new discovery surface.
- Cleaned the useful test surface for the changed product shape by consolidating repetitive registration tests and adding focused coverage for mode discovery, task-phrase lookup, tool definition compaction, and release ledger accounting.
- Refreshed package-facing docs, release notes, and readiness evidence for the current model-access contract.

## 1.0.34 - 2026-06-04

- Promoted GoodVibes Agent to the stable 1.0.x operator product surface: the fullscreen Agent workspace is the primary TUI, with setup, provider/model routing, status, compatibility, and doctor flows shaped around personal operator use instead of copied host lifecycle controls.
- Completed the Agent-local behavior system for day-one operation: local memory and notes, personas, skills, skill bundles, routines, starter profiles, discovery/import flows, review/stale/delete controls, and secret-looking content rejection all stay under Agent ownership.
- Completed isolated Agent Knowledge coverage across CLI, slash commands, workspace panels, connector/source/node/issue views, URL/file/browser/connector ingest, semantic ask/search, and connected-host `/api/goodvibes-agent/knowledge/*` routes without fallback to default or non-Agent knowledge surfaces.
- Completed connected-host operator integration without taking host lifecycle ownership: compatibility/status checks, authenticated health and model routes, channel readiness, provider-account posture, approvals, automation snapshots, schedules, work plans, media/voice readiness, pairing, and explicit public-route diagnostics are all visible from Agent.
- Completed explicit side-effect boundaries for personal operation: channel sends, notifications, routine schedule promotion, reminders, subscription/auth actions, memory bundle imports/exports, support bundles, MCP configuration, profile changes, and build delegation require explicit confirmation where they mutate state or call external routes.
- Completed package and release hardening for the release gate: Bun-only install/run instructions, package-facing text verification, package runtime bundling, packed global install smoke, blocked lifecycle command smoke, source/package boundary checks, architecture checks, recorded performance snapshot checks, verification ledger, strict live verification artifacts, and release-quality readiness inventory dimensions are now part of the validated release path.
- Completed the compact model-visible harness pass: `agent_harness` summary and plural catalogs now default to compact rows, with full schemas, policy blocks, route metadata, editor fields, release artifact detail, redacted log tail, and parameter detail behind `includeParameters:true` or singular inspect modes.
- Completed direct model access to Agent harness operations: workspace actions, slash commands, settings, panels, UI surfaces, keybindings, tool catalogs, channel/notification posture, provider/account posture, MCP posture, setup, model routing, pairing, delegation, security/support bundles, media, sessions, operator methods, and connected-host diagnostics are exposed through Agent tools or harness modes; packaged release evidence remains model-inspectable as operator/audit material.
- Completed connected-host daemon aliases for the model: `daemon` maps to connected-host posture and `daemon_status` maps to live connected-host status while lifecycle control stays outside Agent.
- Completed settings parity for the model-facing harness: settings discovery is compact by default, `get_setting` and `includeParameters:true` expose full descriptors, and `set_setting`/`reset_setting` use the same config/secret managers with confirmation and external-host setting locks.
- Completed the tool-description verbosity sweep: first-class Agent tools and wrapped built-in tool definitions now register concise descriptions, while detailed safety rules remain enforced in policy wrappers, confirmation errors, and detailed harness inspection.
- Completed copyable model route hint cleanup: confirmed harness examples now include the required `confirm:true` and `explicitUserRequest` fields so route hints match the actual execution contract.
- Completed resilient shortcut/keybinding discovery: `agent_harness` returns fixed shortcuts and default-fallback keybinding descriptors when the live keybinding manager is absent, while keybinding execution and mutation still fail closed until the runtime manager is available.
- Completed the model-visible operator method catalog: `agent_harness` can now list and inspect allowlisted public operator and Agent Knowledge methods with their owning first-class model tools, confirmation policy, and boundaries, without exposing arbitrary route invocation.
- Expanded first-class Agent Knowledge reads: `agent_knowledge` now covers status, ask, search, source/node/issue lists, item lookup, map summary, connector list/detail, and connector doctor while staying inside `/api/goodvibes-agent/knowledge/*`.
- Added fail-closed Agent Knowledge response-scope validation: CLI, model tools, and live verification reject successful-looking payloads that expose default scope metadata or known non-Agent payload markers.
- Expanded release-route enforcement for Agent Knowledge: architecture/package policy now guards the full route catalog, and live verification definitions include source, node, issue, map, and connector read routes in addition to status, ask, and search.
- Verified the release line against connected-host public Agent routes for Agent Knowledge alias scope normalization and telephony channel surface support.
- Renamed active release evidence artifacts to current-release paths under `release/`, including release notes, readiness inventory, performance snapshot, and live-verification reports, so current release metadata no longer depends on stale historical filenames.

## 1.0.33 - 2026-06-04

- Fixed the release lockfile so frozen CI installs resolve the published connected-host route dependency graph.
- Carries forward the 1.0.32 model-facing harness coverage, compact tool catalog, keybinding discovery fallback, and connected-host release evidence.

## 1.0.32 - 2026-06-04

- Align the Agent release line with connected-host public route support for Agent Knowledge alias scope normalization and telephony channel surface support.
- Refresh release readiness evidence to match the current strict live verification run: 19 pass, 0 warn, 0 fail, 0 skip.
- Treat environment-provisioned connected-host operator tokens as first-class status, doctor, auth, pairing, Agent Knowledge, and model-visible connected-host credentials.
- Expose channel readiness through `agent_harness` with summary/search and single-channel lookup so the model can inspect setup state, delivery posture, risk labels, and safe config-key names before using the explicit confirmed send tool.
- Expose notification target posture through `agent_harness` with redacted summary/search and single-target lookup so the model can inspect configured target readiness without receiving full webhook values.
- Expose provider account posture through `agent_harness` with summary/search and single-provider lookup so the model can inspect auth routes, subscription freshness, usage windows, route issues, and confirmation-gated account actions without receiving tokens.
- Expose MCP server posture through `agent_harness` with summary/search and single-server lookup so the model can inspect connection, trust, role, quarantine, and tool inventory posture before using explicit confirmed workspace or slash-command mutation flows.
- Expose setup/onboarding posture through `agent_harness` with summary/search and single setup-item lookup so the model can inspect onboarding snapshot state, derived capability flags, setup marker state, local behavior discovery, channel/media/setup signals, and setup collection issues without applying setup.
- Expose provider/model routing through `agent_harness` with summary/search and single route/model lookup so the model can inspect current chat route, selectable models, provider ids, pinned models, reasoning support, context windows, and safe route setting keys without changing routes.
- Expose companion pairing posture through `agent_harness` with summary/search and single pairing-route lookup so the model can inspect endpoint binding, pairing surface id, token presence/fingerprint, and route catalog without receiving raw tokens or QR payloads.
- Expose explicit build-delegation posture through `agent_harness` with summary/search and single-route lookup so the model can inspect delegation routes, runtime availability, review policy, main-conversation ownership, and blocked local coding ownership without submitting delegated work.
- Expose security/support posture through `agent_harness` with redacted summary/search, single-finding lookup, bundle route discovery, and existing-bundle inspection by counts and redaction metadata without returning raw config, token, or secret values.
- Expose voice/media posture through `agent_harness` with summary/search and single-provider lookup so the model can inspect provider readiness, selected TTS setup, browser-tool posture, artifact availability, and safe secret-key names before using confirmed media generation or settings routes.
- Expose sessions/bookmarks through `agent_harness` with current-session posture, saved-session metadata/search, bookmark counts, saved bookmark file counts, and single-session lookup while save/resume/export/delete/bookmark changes stay visible user flows.
- Compact model-facing tool registration and schema descriptions, with package verification thresholds to prevent tool-description bloat from returning.
- Compact `agent_harness` summary route hints so the model gets concise mode names and confirmation rules instead of paragraph-length surface guidance.
- Keep shortcut and keybinding discovery available when the live keybinding manager is absent by returning default-fallback descriptors while keybinding execution and mutation still fail closed.

## 1.0.31 - 2026-06-04

- Expose the packaged release evidence bundle through agent_harness so the model can inspect release notes, performance snapshot, readiness inventory, and live-verification artifacts.
- Expose service posture and single-endpoint diagnostics through agent_harness so the model can inspect status/doctor/support-bundle endpoint posture without connected-host lifecycle control.
- Expose the public operator method catalog through agent_harness with preferred first-class tool routes and single-method lookup, without arbitrary route invocation.
- Expand agent_knowledge beyond status/ask/search to cover read-only source, node, issue, item, map, connector, and connector doctor inspection.
- Expand live verification definitions to check isolated Agent Knowledge source, node, issue, map, and connector routes in addition to status, ask, and search.
- Strengthen architecture/package policy so the full Agent Knowledge route catalog remains Agent-specific.
- Reject Agent Knowledge responses that expose default scope metadata or known non-Agent payload markers across CLI, model tools, and live verification.
- Count the packaged release evidence bundle and release-evidence harness modes in the verification ledger.
- Count the model-visible service posture modes and endpoint ids in the verification ledger.
- Count the model-visible operator method catalog modes and sources in the verification ledger.
- Expose settings catalog filters in the agent_harness summary so the model can discover category, prefix, query, includeHidden, and limit before mutating settings.
- Expose model-tool catalog schema inlining in the agent_harness summary and package docs.
- Add focused harness coverage for settings filter guidance and model-tool includeParameters schema inlining.

## 1.0.30 - 2026-06-04

- Surface workspace and workspace_categories modes in the agent_harness summary and package docs so the model can discover the Agent workspace category catalog before action lookup.
- Keep workspace action/editor execution guidance unchanged while documenting the category catalog/action-count route.
- Add focused harness coverage for workspace category discovery and summary guidance.

## 1.0.29 - 2026-06-03

- Add preferred model-route metadata to every built-in slash command policy so command inspection always tells the model which Agent-owned route to use.
- Add preferred route metadata to every supported top-level CLI mirror, including current-conversation handling for non-interactive run mirrors.
- Refresh 1.0.x package docs and focused harness coverage for exhaustive command and CLI preferred-route metadata.

## 1.0.28 - 2026-06-03

- Expose modelExecution metadata for every Agent workspace editor action, including local-registry, command-backed, direct local-create, profile, and prompt-returning editor flows.
- Return editor execution-route metadata in workspace action handoffs so the model can complete forms without guessing the route.
- Refresh 1.0.x package docs and focused harness coverage for workspace editor execution parity.

## 1.0.27 - 2026-06-03

- Classify every built-in slash command with concrete model-visible effect and boundary policy metadata instead of generic unknown policy fallback.
- Document that built-in slash-command inspection returns concrete effect and boundary policy metadata.
- Add focused harness coverage so registered built-in slash commands cannot silently regress to unknown model policy.

## 1.0.26 - 2026-06-03

- Route confirmed agent_harness panel-close and panel-close-all keybinding runs through the same Agent workspace dismiss route as the user shortcut before falling back to panel close handling.
- Refresh model-operation metadata for panel close keybindings so supported keybinding behavior matches visible shell behavior.
- Add focused harness coverage for model-triggered Agent workspace dismissal.

## 1.0.25 - 2026-06-03

- Correct the model-visible fixed shortcut catalog so F2 is reported as the runtime activity monitor instead of the shortcut reference.
- Expose /shortcuts separately as the keyboard shortcut reference route.
- Add focused harness coverage for runtime activity and shortcut-reference discovery.

## 1.0.24 - 2026-06-03

- Resolve confirmed `agent_harness` `mode:"run_command"` requests by the same command, commandName, target, or query lookup used for slash-command inspection.
- Refuse ambiguous slash-command run lookups with candidate commands before any handler runs.
- Refresh package-facing docs, model-facing schema text, and focused harness coverage for slash-command execution parity.

## 1.0.23 - 2026-06-03

- Return ambiguous agent_harness slash-command detail lookups with candidate commands instead of collapsing broad descriptive matches to unknown.
- Keep exact slash command, alias, typed command, target, and unique descriptive lookup behavior unchanged.
- Refresh package-facing docs and focused harness coverage for no-guess slash-command lookup parity.

## 1.0.22 - 2026-06-03

- Refuse ambiguous agent_harness model-tool schema lookup with candidate tools instead of selecting the first partial match.
- Refuse ambiguous connected-host capability lookup with candidate capabilities while preserving exact and unique lookup behavior.
- Refresh model-visible harness parameter descriptions, preferred route hints, package docs, and focused harness coverage for no-guess single-item lookup parity.

## 1.0.21 - 2026-06-03

- Resolve `agent_harness` `mode:"run_workspace_action"` by actionId, command, target, or query using the same lookup contract as `mode:"workspace_action"` inspection.
- Refuse ambiguous workspace action run requests with candidate actions instead of requiring exact action ids or guessing.
- Refresh package-facing docs and focused harness coverage for workspace action run parity.

## 1.0.20 - 2026-06-03

- Add `agent_harness` `mode:"run_keybinding"` for confirmation-gated shell-safe shortcut equivalents such as search, prompt-history search, paste, clear screen, cancel generation, panel focus/close routes, and visible block-action routing.
- Add modelOperation route metadata to every configurable keybinding so the model can distinguish supported shell routes from prompt-editor-only or direct-interaction shortcuts.
- Refresh package-facing docs and focused harness coverage for keybinding operation parity.

## 1.0.19 - 2026-06-03

- Add agent_harness cli_command lookup by cliCommand, command, commandName, target, or query while preserving parsed metadata for concrete invocations.
- Search the top-level CLI mirror catalog for descriptive lookup text and return candidate mirrors instead of treating broad text as a hidden CLI command.
- Redact CLI config override values in lookup metadata and refresh package-facing docs plus focused harness coverage.

## 1.0.18 - 2026-06-03

- Add agent_harness panel lookup by panelId, target, or query, with ambiguity candidates for visible panel routing.
- Add agent_harness UI surface lookup by surfaceId, target, or query, with ambiguity candidates for visible UI routing.
- Add agent_harness keybinding lookup by actionId, target, key, or query, including formatted binding labels and ambiguity candidates for confirmed keybinding edits.

## 1.0.17 - 2026-06-03

- Add agent_harness setting lookup by key, target, or query for get_setting, set_setting, and reset_setting.
- Return setting lookup metadata on successful single-setting operations and refuse ambiguous matches with candidate settings instead of guessing.
- Refresh package-facing docs and focused harness coverage for model-visible setting inspection and confirmed mutation lookup.

## 1.0.16 - 2026-06-03

- Add `agent_harness` `mode:"workspace_action"` lookup by actionId, command, target, or query with resolved lookup metadata.
- Reuse the user-facing workspace action search fields for single-action inspection while reporting ambiguity with candidate actions instead of guessing.
- Refresh package-facing docs and focused harness coverage for the updated model-visible workspace action inspection path.

## 1.0.15 - 2026-06-03

- Add forgiving agent_harness slash-command detail lookup by command, commandName, target, or query with parsed invocation metadata.
- Keep slash-command catalogs lightweight while making one-command inspection work from typed user-style invocations, aliases, case-insensitive roots, and unique description matches.
- Refresh package-facing docs and focused harness coverage for the updated model-visible slash-command inspection path.

## 1.0.14 - 2026-06-03

- Add agent_harness mode tool to inspect one first-class model tool schema by toolName, target, or query.
- Keep broad tools discovery lightweight while making individual model tool parameters, side effects, concurrency, and streaming/progress support directly inspectable.
- Refresh package-facing docs and focused harness coverage for the updated model tool discovery surface.

## 1.0.13 - 2026-06-03

- Add connected_host_capability to inspect one allowed or blocked connected-host capability by id, target, or query with related route families and boundary text.
- Keep connected-host operation model-visible without exposing host lifecycle, listener, non-Agent knowledge, hidden background work, or arbitrary host mutations.
- Refresh package-facing docs and focused harness coverage for the updated connected-host capability map.

## 1.0.12 - 2026-06-03

- Expose command browser, reasoning-effort picker, and live process output as model-visible confirmation-gated harness UI surfaces.
- Allow confirmed run_workspace_action execution for local memory, note, persona, skill, and routine create editors through agent_local_registry with required-field validation.
- Refresh package-facing docs for current 1.0.x harness parity and keep coverage aligned with the completed user-facing and model-facing surface map.

## 1.0.11 - 2026-06-03

- Model-visible harness parity now opens conversation search, prompt history search, slash-command mode, file picker, and nearest-block actions through confirmation-gated visible shell routes.
- Documentation now names the current UI surface inventory for 1.0.x so users and the model share the same harness map.
- Harness assertions cover the new visible surface routes and preserve the existing safety boundary.

## 1.0.10 - 2026-06-03

- Expose the runtime activity monitor as a model-visible, confirmation-gated harness UI surface, wire the shell opener through CommandContext, and refresh package-facing docs and focused coverage for the current 1.0.x surface map.

## 1.0.9 - 2026-06-03

- Expose TTS provider and voice pickers through the model-visible harness, make /help and /commands use the live slash-command registry, and refresh package-facing docs and focused coverage for the current 1.0.x surface map.

## 1.0.8 - 2026-06-03

- Added model-visible UI surface entries for the panel-picker compatibility route and the security, knowledge, and subscription operator surfaces.
- Routed those named operator surfaces through Agent Workspace or the existing panel route with confirmation.
- Updated package-facing docs and focused harness coverage so the documented 1.0.x model-visible surface map matches the TUI routes.

## 1.0.7 - 2026-06-03

- Refreshed package-facing docs index so the latest 1.0.x release is derived from package.json and the top changelog entry instead of a stale hard-coded patch number.
- Updated the docs baseline constraints to include live connected-host readiness as part of the model-visible Agent-owned harness surface.

## 1.0.6 - 2026-06-03

- Added agent_harness mode connected_host_status for live read-only connected-host readiness: status-route reachability, host compatibility, token posture, endpoint bindings, Agent Knowledge route readiness, findings, and lifecycle boundaries.
- Documented the new model-visible connected-host readiness surface and added focused harness coverage proving the raw operator token is not exposed.

## 1.0.5 - 2026-06-03

- Model-visible harness discovery now includes modal, overlay, picker, and workspace UI surfaces with preferred model routes and shell-opener availability.
- open_ui_surface now routes visible Agent shell navigation through the same user-facing openers for settings, MCP, model/provider pickers, session/profile pickers, bookmarks, context, help, shortcuts, onboarding, and Agent workspace.
- The agent_harness tool schema now lives in a focused helper so new harness surface modes stay within architecture size limits.

## 1.0.4 - 2026-06-03

- Model-visible harness control now exposes fixed shortcuts and configurable keybindings through shortcuts, keybindings, keybinding, set_keybinding, and reset_keybinding modes.
- Keybinding edits now write the same Agent keybindings.json file the user edits, reload the runtime keybinding manager, and require explicit confirmation.
- Package-facing docs now describe shortcut and keybinding parity for the current 1.0.x harness surface.

## 1.0.3 - 2026-06-03

- Model-visible harness discovery now includes top-level CLI mirrors with parser output, blocked command tokens, redacted launch overrides, and preferred in-process routes.
- Model-visible harness discovery now includes built-in panel catalog/open-state inspection plus confirmation-gated visible panel routing through the Agent operator surface.
- Harness metadata was split into focused catalog helpers to keep architecture boundaries and source-size limits intact.
- Documentation now describes CLI mirror and panel harness visibility, including the no-hidden-CLI-process and connected-host boundary rules.

## 1.0.2 - 2026-06-03

- Model-visible harness control now exposes command, settings, workspace, tool, and connected-host surfaces through agent_harness.
- Agent settings access now includes schema-aware list/get/set/reset flows with redaction, secret-manager writes, and host-owned read-only boundaries.
- Workspace profile, routine, persona, and local-library flows now expose editor schemas and scriptable actions to the model.
- Documentation now reflects the current 1.0.x command, tool, settings, provider, channel, knowledge, voice, connected-host, and release behavior.

## 1.0.1 - 2026-06-03

- Preserved Agent Knowledge setup paths with spaces, quoted generated Agent command guidance, and hardened MCP trust and role command validation.
- Blocked MCP allow-all escalation from Agent slash commands while keeping Settings as the explicit allow-all surface.
- Preserved MCP server passthrough arguments after -- and local persona, skill, and routine text that starts with flag-like values.
- Kept the 1.0 release package and install gates green across typecheck, architecture, performance, package build, publish check, packed install smoke, and verification ledger.

## 1.0.0 - 2026-06-03

- Promoted GoodVibes Agent to the stable 1.0.x operator product surface: the fullscreen Agent workspace is the primary TUI, with setup, provider/model routing, status, compatibility, and doctor flows shaped around personal operator use instead of copied host lifecycle controls.
- Completed the Agent-local behavior system for day-one operation: local memory and notes, personas, skills, skill bundles, routines, starter profiles, discovery/import flows, review/stale/delete controls, and secret-looking content rejection all stay under Agent ownership.
- Completed isolated Agent Knowledge coverage across CLI, slash commands, workspace panels, connector/source/node/issue views, URL/file/browser/connector ingest, semantic ask/search, and connected-host `/api/goodvibes-agent/knowledge/*` routes without fallback to default or non-Agent knowledge surfaces.
- Completed connected-host operator integration without taking host lifecycle ownership: compatibility/status checks, authenticated health and model routes, channel readiness, provider-account posture, approvals, automation snapshots, schedules, work plans, media/voice readiness, pairing, and explicit public-route diagnostics are all visible from Agent.
- Completed explicit side-effect boundaries for personal operation: channel sends, notifications, routine schedule promotion, reminders, subscription/auth actions, memory bundle imports/exports, support bundles, MCP configuration, profile changes, and build delegation require explicit confirmation where they mutate state or call external routes.
- Completed package and release hardening for the 1.0 gate: Bun-only install/run instructions, package-facing text verification, package runtime bundling, packed global install smoke, blocked lifecycle command smoke, source/package boundary checks, architecture checks, recorded performance snapshot checks, verification ledger, strict live verification artifacts, and release readiness inventory are now part of the validated release path.

## 0.1.117 - 2026-06-02

- Added TUI workspace entrypoints for Agent Knowledge connectors, source/node/issue list views, review queue, transcript controls, doctor diagnostics, and connected-host compatibility.
- Added a TUI-first command coverage regression so product CLI commands cannot drift into shell-only workflows.
- Updated package-facing docs and help to describe the fullscreen Agent workspace as the primary product surface, with CLI commands only as scriptable mirrors.

## 0.1.116 - 2026-06-02

- Added behavior discovery to first-run setup so local persona, skill, and routine files can be reviewed and imported from the Agent TUI instead of starting from blank records.
- Added profile creation from discovered behavior bundles, including local starter-template creation, profile creation, and in-workspace setup guidance.
- Kept the installed command path simple: `bun add -g @pellux/goodvibes-agent`, then `goodvibes-agent` starts the interactive Agent TUI.
- Preserved the Agent product boundary: connected host required, no Agent-owned host lifecycle, isolated Agent Knowledge only, local memory/skills/personas/routines, and explicit build delegation.

## 0.1.108 - 0.1.115

- Expanded day-one setup with local behavior import, starter profiles, profile templates, Agent workspace forms, and clearer launch/status identity.
- Added Agent Knowledge management for isolated URL, file, connector, bookmark, and browser-history ingest through `/api/goodvibes-agent/knowledge/*`.
- Improved channel readiness, voice/media setup, provider/model visibility, MCP setup, and routine scheduling workflows while keeping side effects behind explicit confirmation.
- Hardened the package runtime bundle and Bun global install smoke so the installed TUI must launch from a packed package.

## 0.1.80 - 0.1.107

- Made the Agent operator workspace the normal TUI landing surface after first-run setup.
- Added Agent-local memory, personas, skills, skill bundles, routines, schedule receipts, and schedule reconciliation.
- Added connected-host diagnostics for status, compatibility, auth presence, Agent Knowledge readiness, approvals, work plans, automation, and schedules.
- Strengthened release gates around Bun-only install, TypeScript-only source, package contents, packed install checks, and single branch-CI test execution.

## 0.1.63 - 0.1.79

- Reworked onboarding, settings, help, docs, and workspace language around the Agent product: operator TUI, local behavior, isolated Agent Knowledge, provider access, channel readiness, automation review, and explicit build delegation.
- Added first-run readiness review covering runtime connection, default model route, profile setup, Agent Knowledge, local behavior, channels, routines, schedules, and delegation.
- Added workspace and renderer improvements for readable setup guidance, wrapped detail text, tiny-terminal behavior, and profile creation flows.

## 0.1.48 - 0.1.62

- Added the first Agent setup checklist, local library workspaces, local library editors, delete confirmations, command-help polish, and Bun global PATH guidance.
- Removed developer-only and coding-intelligence surfaces from the visible Agent product.
- Improved non-TTY launch diagnostics and package install smoke coverage.

## 0.1.2 - 0.1.47

- Added isolated Agent Knowledge CLI and slash-command routing with no fallback to default knowledge/wiki or non-Agent knowledge segments.
- Added Agent-local personas, skills, and routines with create/list/search/show/review/stale/delete workflows and secret-looking value rejection.
- Added explicit build/fix/review delegation to the GoodVibes build environment; delegated review is requested only through explicit delegation.
- Established release checks for package-facing docs, installability, executable bin behavior, and Agent product policy.

## 0.1.0 - 0.1.1

- Published the first public alpha package for `@pellux/goodvibes-agent`.
- Exposed the `goodvibes-agent` executable as the TUI entrypoint.
- Established the core Agent policy: serial/proactive assistant behavior, connected-host dependency, no local worker fanout by default, isolated Agent state, and explicit build delegation.
- Reissued `0.1.1` after the initial registry publish produced an install-blocking package metadata inconsistency.

## 0.0.0 - Private Baseline

- Created the private Agent package baseline with the GoodVibes terminal shell foundation.
- Set package identity to `@pellux/goodvibes-agent`.
- Kept host lifecycle external to the Agent package.
- Started the Agent-specific operator workspace, local behavior registries, and product policy work that led to the public alpha.
