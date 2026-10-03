# Providers and routing

GoodVibes Agent uses the provider/model configuration exposed by the connected GoodVibes host. The Agent TUI should make the active route easy to see and easy to change, but it should not duplicate provider hosting logic.

## Agent expectations

Provider and model state should be visible in:

- the shell footer/status rows;
- `/health` in the TUI and `goodvibes-agent status` in the CLI;
- `/model` and `/provider`;
- the Agent operator workspace setup checklist;
- the TTS configuration workspace when spoken turns are used;
- `models action:"status|route|local|providers|provider|smoke"` when the model needs provider/model route posture, selectable model metadata, pinned model status, reasoning support, context-window posture, readiness scores, safe setting keys, provider auth posture, subscription freshness, or the hardware-scored local model cookbook;
- the same `models` routes with `includeParameters:true`, `action:"route"`, or `action:"provider"` for full capabilities, readiness dimensions, the local hardware profile, fit scores, setup/download guidance, local endpoint candidates with exact endpoint inspection, model-list smoke commands and triage, saved benchmark evidence, route-change hints, usage windows, issues, notes, and auth-flow hints;
- lower-level `agent_harness` modes `model_routing`, `model_route`, `provider_accounts`, `provider_account`, and confirmed `run_local_model_smoke`, which remain available for compatibility and detailed harness inspection; provider/account mutations stay on confirmed workspace or settings routes.

When a selected model is provider-qualified, Agent keeps the runtime provider row and raw model id separate. For example, `openai-subscriber` plus `openai:gpt-5.5` should route as provider `openai-subscriber` and model `gpt-5.5` where the public route expects provider/model fields.

## Local provider definitions

Agent-owned provider definitions live under the Agent profile root when supported by the shared GoodVibes provider registry:

```text
~/.goodvibes/agent/providers/*.json
```

These files are local configuration. They are not Agent Knowledge records and should not be copied into knowledge search state.

## Local model cookbook

The Models workspace (Agent Workspace -> Models) keeps inspection, comparison, and route changes separate so nothing switches a model implicitly. Its detail pane summarizes route readiness, the local cookbook, local server checks, and benchmark evidence, and the model-visible `models` tool carries the same surfaces under these routes:

| Surface | What it does |
| --- | --- |
| Choose provider and model | Workspace picker action for the main chat route; helper, tool, and spoken-turn routes have their own picker rows. |
| Run a local model benchmark | Confirmed workspace action that runs a local-route benchmark through blind comparison and saves latency/task-fit evidence without changing the route. |
| `models action:"status"` | Route readiness scores, missing signals, pinned state, and safe route keys. |
| `models action:"local"` | The hardware-scored local model cookbook with recipe ranking and setup/download guidance. |
| `models action:"route"` | Exact endpoint inspection for one route, with model-list smoke commands, success criteria, and failure triage. |
| `models action:"smoke"` | Confirmed model-list smoke checks against detected or default local endpoints. |

The cookbook covers Ollama, llama.cpp, vLLM, and local OpenAI-compatible servers. It detects local-compatible provider ids and model routes when available, scans local OS CPU/RAM/platform data with safe accelerator hints, ranks recipe fit, and recommends the easiest first route. Each recipe's setup plan carries download/start guidance, local server endpoint candidates, provider-add route hints when no route exists yet, provider-refresh routes, and saved local benchmark comparison artifacts when they exist.

Every selectable model and local recipe gets a 0-100 readiness score with dimensions for latency, context window, tool support, vision, cost, and privacy. Scores are estimated unless a live route benchmark has been recorded; they are intended for triage, not as hidden permission to switch the user's default model.

Saved local benchmark artifacts are tagged through `agent_model_compare` with `benchmarkKind:"local-model-route"` and `taskType:"local-model-route"`; revealed winner judgments raise matching recipe confidence to measured evidence, and benchmark analytics open on that filtered slice. Default-model changes still require a separate confirmed route update.

The cookbook does not probe drivers, call local network endpoints, install servers, download models, or change the selected route. Live local benchmark execution is a separate confirmed action that spends model tokens, saves comparison evidence, and leaves default-model changes to a separate revealed judgment and confirmed apply step.

## Discovery and health

Provider discovery and health are owned by the connected GoodVibes host. Agent can display discovered provider status, model context information, and route failures. It should not hide provider failures behind fallback wording that makes a failed chat or knowledge request look successful.

## Search, voice, and media providers

Search, voice, media, and multimodal providers are valid Agent features when they are presented as assistant workflows:

- research and source lookup;
- live spoken turns;
- image/document analysis;
- artifact creation and review.

Outputs that should become durable knowledge must go through Agent Knowledge routes. No provider output should be inserted into default knowledge or another product segment by Agent.

Setting discovery is compact by default through `settings action:"list"` and full with `includeParameters:true` or `settings action:"get"`. Setting changes use `settings action:"set|reset"` only when the user explicitly asks and provides confirmation. `models action:"status|route|local|providers|provider"` is read-only; `models action:"smoke"` is confirmation-gated. Model/provider selection, catalog refresh, pin/unpin, custom provider edits, and route setting changes stay visible picker, settings, workspace, or slash-command flows. Secret-backed provider or channel values are stored through the secret manager and displayed as redacted references.

## Related docs

- [Getting started](getting-started.md)
- [Knowledge, artifacts, and multimodal](knowledge-artifacts-and-multimodal.md)
- [Voice and live TTS](voice-and-live-tts.md)
