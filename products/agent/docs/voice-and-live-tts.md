# Voice and live TTS

GoodVibes Agent supports spoken turns as an Agent TUI feature. Text output remains primary; voice is an additional local playback path for a normal assistant turn.

## Commands

```text
/tts <prompt>
/tts stop
/config tts
/config tts.provider
/config tts.voice
/config tts.llmProvider
/config tts.llmModel
```

`/tts <prompt>` submits the prompt through the normal Agent conversation path. It uses the active chat provider/model unless a separate spoken-turn model override is configured.

`/tts stop` cancels queued spoken output and active playback without cancelling the text transcript.

`/config tts` opens the fullscreen configuration workspace for streaming provider, voice, and spoken-turn model routing.

The model can inspect the same settings through `settings action:"list|get"`, use `device action:"voice|provider"` for voice/media posture and provider inspection, open the visible TTS provider or voice picker through `device action:"open_tts_provider|open_tts_voice"` with confirmation, and change Agent-owned TTS settings with `settings action:"set"` plus explicit confirmation.

Lower-level `mode:"media_posture"` is compact by default; use `includeParameters:true` or `mode:"media_provider"` for full provider readiness, generation route hints, picker routes, and media policy detail. It also returns a voice workflow map for push-to-talk input, voice memo transcription, spoken responses, and wake-word capture, with ready/attention/setup-needed/not-published states, exact setup routes, and certified SDK/daemon permission-scoped live records when published.

The wake row in that map reports this surface's capture host, covering whether both enablement rows are on, which recorder is configured, and whether a row is refusing to start it. It keeps the paired-phone half in its own evidence field.

Workspace action discovery includes compact `modelRoute` hints for TTS prompts, image input, and confirmed media generation; generated image/video requests use `agent_media_generate` when the user asks for that effect. Connected-host listener or lifecycle settings remain outside Agent ownership.

## Wake-word capture

Wake-word detection runs on this surface. It is off by default in two places, and
both have to be on before a microphone is opened. `voice.wake.enabled` turns the
feature on, and `voice.wake.surfaces.agent` delivers it here, off by default because
two terminal surfaces both acting on one spoken utterance is a confusing default.
Nothing about this is implicit. A configuration that is off never opens a device and
never produces a microphone permission prompt.

Capture uses an external recorder command. `voice.wake.captureCommand` names one,
or `auto` (the default) probes them in this order and uses the first one installed:

| Recorder | Audio stack it serves |
| --- | --- |
| `pw-record` | PipeWire, probed first |
| `parecord` | PulseAudio |
| `arecord` | ALSA |
| `ffmpeg` | General-purpose capture through each platform's input framework |
| `sox` | General-purpose capture, probed last |

What happens when both enablement rows are on:

1. The recorder subprocess starts. A named recorder that is not installed is
   reported, not silently replaced.
2. Every 80 ms frame is scored against the pinned "hey goodvibes" classifier through
   onnxruntime-web on its WASM backend. The models are NOT downloaded automatically.
   Run `/voice wake status` to see what is on disk (verified by content, so a
   truncated file reads as corrupt rather than present) and `/voice wake setup --yes`
   to download them. The same provision also fetches the speech gate
   `voice.wake.vadThreshold` uses, reported separately because the detector runs
   without it. An enabled detector with no models says so instead of
   pretending to listen.
3. A confirmed wake plays `voice.wake.activationSound` and shows a persistent
   listening row in the footer per `voice.wake.indicator`. An always-on microphone
   is never invisible here.
4. The utterance that FOLLOWS the wake is recorded on the same open stream (seeded
   with `voice.wake.preRollMs` of audio from before it fired, so a phrase run into
   the command is not clipped), ended by `voice.wake.silenceStopMs` of silence or the
   `voice.wake.captureMaxSeconds` ceiling, and transcribed through this process's own
   voice service, the same call the `voice.stt` verb serves. The text lands in the
   conversation input, or is submitted as a turn when `voice.wake.autoSubmit` is on.
5. A capture stream that dies is restarted per `voice.wake.maxRestarts` and
   `voice.wake.restartBackoffMs`, and latches off with a stated reason when the budget
   is spent. The footer row says which of those is happening.

### Noise suppression and the speech gate

`voice.wake.noiseSuppression: speex` applies SpeexDSP's denoiser. The filter is a
WebAssembly module embedded inside the platform package rather than downloaded, so
there is no state in which the row is configured, unprovisioned, and therefore not
filtering. It sits between the device and every consumer, so the engine scores
filtered frames, the utterance recorded after a wake is filtered, and the pre-roll
carried from before the wake is filtered. `none` inserts no stage at all; audio
bytes reach every consumer unmodified.

`voice.wake.vadThreshold` above 0 screens frames through a speech gate before the
wake classifier sees them, so non-speech costs no classifier inference. The gate is a
pinned head that runs over the SAME embedding the classifier consumes, and it
provisions with the wake models. `/voice wake status` reports it separately from the
classifier, because the detector is fully operational without it (the default is 0).
Its threshold table is measured rather than guessed, and `/voice wake status` prints
what the configured value passes and stops.

One refusal is deliberate. `voice.wake.vadThreshold` above 0 on a host that does not
have the gate on disk refuses to start the detector, because frames reaching the
classifier unscreened while the row says they were screened is exactly what the
refusal exists to prevent. Run `/voice wake setup --yes` and the detector starts.

A runtime with no WebAssembly at all refuses `speex` for the same class of reason,
in the platform's own wording, so it reads identically on every surface.

`voice.wake.surfaces.tui`, `voice.wake.surfaces.webui` and `voice.wake.browserBackend`
are other surfaces' rows and change nothing here. The model's published recall figures
are measured on synthesised speech only. No human has recorded the phrase.

The `voice.wake.*` keys this surface reads, with their defaults:

| Key | Default | What it controls |
| --- | --- | --- |
| `voice.wake.enabled` | off | The feature switch; off never opens a device |
| `voice.wake.surfaces.agent` | off | Delivery of wake events to this surface |
| `voice.wake.captureCommand` | `auto` | Which recorder starts, per the table above |
| `voice.wake.activationSound` | `chime` | The sound played on a confirmed wake |
| `voice.wake.indicator` | `statusline` | Where the persistent listening row renders |
| `voice.wake.preRollMs` | 500 | Audio carried from before the wake fired into the recorded utterance |
| `voice.wake.silenceStopMs` | 1200 | Silence that ends the post-wake utterance |
| `voice.wake.captureMaxSeconds` | 10 | Hard ceiling on post-wake capture length |
| `voice.wake.autoSubmit` | off | Submit the transcription as a turn instead of placing it in the input |
| `voice.wake.maxRestarts` | 3 | Restart budget for a capture stream that dies |
| `voice.wake.restartBackoffMs` | 2000 | Delay between those restarts |
| `voice.wake.noiseSuppression` | `none` | The denoise stage described above |
| `voice.wake.vadThreshold` | 0 | The speech gate described above |

Wake capture on a PAIRED PHONE is a different capability and is still reported as
`not-published` until the runtime exposes a certified permission-scoped contract. When
the SDK/daemon publishes certified wake-word records, Agent shows the permission scope,
receipt evidence, and exact inspect/control routes.

## Playback requirements

Live playback streams audio to a local player. Install one of:

- `mpv`, preferred and probed first; its read-ahead cache buffers the incoming stream so the opening audio survives device-open latency;
- `ffplay` (part of FFmpeg), used when `mpv` is not installed.

If neither player is on `PATH`, the Agent still submits and renders the normal text response. Audio is skipped with a concise status message.

## Provider routing

Voice uses providers that advertise streaming TTS capability through the runtime. Agent does not hardcode provider behavior.

Useful setup path:

```text
/config tts.provider
/config tts.voice
/config tts.llmProvider
/config tts.llmModel
```

Leaving `tts.voice` empty lets the provider choose its default voice.

## Knowledge boundary

Spoken responses are conversation output. They are not automatically written to Agent Knowledge, local memory, default knowledge, or any other product segment.

If a spoken result should become durable, store it through an explicit Agent memory command or an Agent Knowledge ingestion path.

## Platform voice-config cohesion

The `tts.*` config keys are defined once, in the shared GoodVibes SDK config schema,
and read identically by every surface, including Agent, the TUI, and the daemon:

| Key | What it sets |
| --- | --- |
| `tts.provider` | Default TTS provider used when no provider is supplied on the request |
| `tts.voice` | Default TTS voice id; empty lets the provider choose its default voice |
| `tts.speed` | Playback speed multiplier for synthesis; 1.0 is normal speed |
| `tts.llmProvider` | Optional LLM provider override for spoken-output turns; empty uses the active chat provider |
| `tts.llmModel` | Optional LLM model override for spoken-output turns; empty uses the active chat model |

Agent does not define its own voice-config schema and does not read `tts.*` through
any path other than the standard `ConfigManager.get`/`set` API that every other Agent
setting uses. Changing `tts.provider` through `/config tts.provider` or
`settings action:"set"` changes the exact same key a TUI user would change through
its own `/config` surface. The key name, type, and default are one contract, not two
independently-maintained ones, and a regression test fails if Agent ever reads a
`tts.*` key outside the shared schema or stops reading it through the shared
`ConfigManager`.

Sharing covers the schema, not the stored values. Each surface still persists its own
values to its own settings file (Agent's under its own surface root, the TUI's under
its own), which is the general per-surface config storage model rather than anything
voice-specific. Setting `tts.voice` on one surface sets the same conceptual value the
other surfaces read under that name, even though each surface keeps its own copy.

Two deliberate boundaries follow from Agent's local-first design:

- **Local synthesis stays local.** Agent synthesizes speech directly against the
  configured provider (through the shared `VoiceService`/`VoiceProviderRegistry`) via
  a local `mpv`/`ffplay` subprocess, rather than routing playback through the daemon's
  `voice.tts`/`voice.tts.stream` HTTP routes. Agent is a terminal tool that must keep
  working when there is no daemon running, so voice output cannot depend on a daemon
  round-trip. The daemon's voice routes exist for network consumers such as the web
  UI, and the config Agent reads to pick a provider is still the one shared contract
  described above.
- **Mic input arrives through the wake word, and only through it.** The platform owns
  the low-level capture routine, the recorder argv, the framing arithmetic, and the
  post-wake utterance policy, and this surface composes them rather than building a
  partial capture flow of its own (see "Wake-word capture" above). Push-to-talk is
  deliberately absent. No key here opens a microphone, because the wake phrase is the
  intended way to speak to the Agent, so `voice.wake.captureMaxSeconds` bounds
  post-wake capture here and nothing else, even though its description also names
  push-to-talk on surfaces that have it.
