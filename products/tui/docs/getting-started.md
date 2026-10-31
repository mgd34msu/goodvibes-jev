# Getting started

## Install

The Jev TUI is a private workspace in `goodvibes-jev`. Follow the
[suite installation guide](../../../docs/installation.md) to build and install
it with the daemon, Agent and WebUI. The installer supports Linux x64/arm64 with
glibc, supplies Bun and Node when needed, and requires a TypeSafe key for Jev.
Run it as your normal user. Upstream npm and `goodvibes.sh` installs do not
install this workspace.

The installer pairs the local TUI and registers a project workspace. Launch
`goodvibes` from that directory, then configure a conversation provider below.
Jev credentials and conversation-provider credentials serve different purposes.
Use `goodvibes --version` and `goodvibes-daemon --version` to inspect the installed
products. Updates and data-preserving uninstall use the suite installer.

For source development, use Bun **1.3.14** and Node **22 or later**. Go is
optional for Go language-server support, and `rust-analyzer` can be downloaded
on first use.

## Configure a model provider

API keys resolve from environment variables first, then from the GoodVibes
secret store. The local store can hold encrypted values directly, or a stored
key can be a reference that resolves through one of eight source kinds at
lookup time:

| Source | Where the value comes from |
| --- | --- |
| `env` | An environment variable, read at resolution time |
| `goodvibes` | The encrypted local secret store itself |
| `file` | A file on disk whose contents are the secret |
| `exec` | A command whose output is the secret |
| `1password` | A 1Password vault item, through the `op` CLI |
| `bitwarden` | A Bitwarden item, through the `bw` CLI |
| `vaultwarden` | A self-hosted Vaultwarden server, through the same `bw` CLI with a `server` parameter |
| `bitwarden-secrets-manager` | Bitwarden Secrets Manager (`bws`), addressed by secret id |

The fastest path is an environment variable:

```sh
export OPENAI_API_KEY=...
```

| Provider | Primary Env Var | Accepted Aliases | Type |
|----------|----------------|-----------------|------|
| Anthropic | `ANTHROPIC_API_KEY` | `CLAUDE_API_KEY` | Paid |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_KEY` | Paid |
| Google Gemini | `GEMINI_API_KEY` | `GOOGLE_API_KEY`, `GOOGLE_GEMINI_API_KEY` | Paid |
| InceptionLabs | `INCEPTION_API_KEY` | none | Paid |
| Mistral | `MISTRAL_API_KEY` | none | Paid |
| OpenRouter | `OPENROUTER_API_KEY` | none | Free tier available |
| Groq | `GROQ_API_KEY` | none | Free (LPU inference) |
| Cerebras | `CEREBRAS_API_KEY` | none | Free (wafer-scale inference) |
| AIHubMix | `AIHUBMIX_API_KEY` | none | Free tier (rate-limited) |
| HuggingFace | `HF_API_KEY` | `HUGGINGFACE_API_KEY`, `HF_TOKEN` | Free tier (rate-limited) |
| Ollama Cloud | `OLLAMA_CLOUD_API_KEY` | `OLLAMA_API_KEY` | Free |
| NVIDIA NIM | `NVIDIA_API_KEY` | none | 1000 free credits |
| LLM7 | `LLM7_API_KEY` | none | Free |

Additional built-in integrations resolve from the same env/secrets path. The cloud-platform and subscription providers use their platforms' own credential variables, and the voice, search, and media providers each take an API key:

| Integration | Variables |
| --- | --- |
| AWS Bedrock | `AWS_BEARER_TOKEN_BEDROCK`, or `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` |
| Anthropic on Vertex AI | `GOOGLE_APPLICATION_CREDENTIALS`, `ANTHROPIC_VERTEX_PROJECT_ID` or `GOOGLE_CLOUD_PROJECT` |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN` |
| Every compatible/gateway provider | Its API key variable, listed per provider in [providers-and-routing.md](providers-and-routing.md) (for example `DEEPSEEK_API_KEY`, `TOGETHER_API_KEY`, `XAI_API_KEY`) |
| Perplexity search | `PERPLEXITY_API_KEY` |
| Deepgram voice | `DEEPGRAM_API_KEY` |
| ElevenLabs voice | `ELEVENLABS_API_KEY` or `XI_API_KEY` |
| Vydra voice | `VYDRA_API_KEY` |
| BytePlus media | `BYTEPLUS_API_KEY` |
| Fal media | `FAL_KEY` or `FAL_API_KEY` |
| Comfy media | `COMFY_API_KEY` (optional, for cloud ComfyUI) |
| Runway media | `RUNWAYML_API_SECRET` or `RUNWAY_API_KEY` |

Alternatively, store keys encrypted using the `/secrets` command:

```sh
/secrets set OPENAI_API_KEY sk-...
```

For self-hosted or external secret managers, link a GoodVibes key to a
provider-backed secret reference:

```sh
/secrets link OPENAI_API_KEY goodvibes://secrets/bitwarden?item=GoodVibes%20OpenAI&field=password&sessionEnv=BW_SESSION
/secrets link SLACK_BOT_TOKEN goodvibes://secrets/vaultwarden?item=GoodVibes%20Slack&field=password&server=https%3A%2F%2Fvault.example.test
/secrets link STRIPE_TOKEN goodvibes://secrets/bws/00000000-0000-0000-0000-000000000000?field=value&accessTokenEnv=BWS_ACCESS_TOKEN
/secrets link OPENAI_API_KEY goodvibes://secrets/1password?vault=Private&item=GoodVibes%20OpenAI&field=API%20Key
```

Use `/secrets providers` for supported provider shapes and `/secrets test <secret-ref>` to validate a ref without printing its value.

Environment variables take precedence over stored secrets when both are present.

## Run from source

From the monorepo root:

```sh
bun install
bun run build
bun run --cwd products/tui dev
```

The TUI runs from `products/tui/src/main.ts` and connects to the daemon as the
compiled binary does. It can adopt a running daemon or start an installed,
stopped daemon service. It does not construct a daemon itself. The daemon
source and build live in `products/daemon` in this same repository; see its
[CLI and composition requirements](../../daemon/README.md).

## Build and run the compiled binary

```sh
bun run --cwd products/tui build:linux-x64
./products/tui/dist/goodvibes-linux-x64
```

This example targets Linux x64 and runs from the monorepo root after the engine
is built. Use `build:linux-arm64` and `dist/goodvibes-linux-arm64` for Linux ARM64;
other declared targets are listed in `products/tui/package.json`. The control
plane, optional HTTP listener and WebUI are hosted by the daemon.

## Tool access and completion

`goodvibes --no-worries-just-vibes` enables `behavior.autoApprove=true` for one
launch, including access outside the project for read/search/map tools. The
same override is available as `--config behavior.autoApprove=true`. Neither
form persists it. Authentication, scopes and other deterministic checks remain
in force. See [CLI flags](cli-flags.md#--no-worries-just-vibes).

Composer input and `--prompt` reach the conversation model directly. Actionable
work then uses [completion verification](../../../packages/engine/docs/runtime-orchestration.md#completion-verification)
before publishing the final answer. Rejected drafts remain private while the
model receives specific repair findings. Ordinary conversation and status
questions can finish while earlier work remains pending.

## Launch and resume

Opening the TUI in a workspace starts a fresh session. Previous work is reached
only deliberately. `--continue` reopens the most recently active session for the
working directory, `--resume [id]` reopens a named one, and `--fork [id]`
branches from one. See [CLI session lifecycle flags](tools-and-commands.md#cli-session-lifecycle-flags).
After the splash, a short notice summarizes the resumable state that actually
exists on disk (saved sessions, workspace checkpoints, chain history) and names
the command that reaches each one.

### The startup recovery modal

If a session crashed before saving, its periodic snapshot survives on disk. At
the next launch, right after the first frame is drawn, the TUI asks about it
instead of leaving a sentence for you to act on. Nothing loads unless you choose
Resume.

The ask is two steps:

1. **Recovery snapshot found.** `Resume it` loads the snapshot into the current
   session and retires the recovery point once the load succeeds. `Not now`
   starts fresh. The row detail names the facts actually known about the
   snapshot, namely session id, age, the title when it carries one, and the
   file size when it can be read.
2. **Remove recovery point?** Asked only after you decline. `Keep it` is first
   and preselected, so the snapshot stays on disk and is offered again the next
   time the workspace opens. `Remove it` deletes it, and the conversation it
   holds cannot be recovered afterwards.

Escape is not an answer. Dismissing either modal leaves the snapshot exactly
where it is. Only `Remove it` deletes anything, and a failed load leaves the
file in place to be offered again next launch. A snapshot whose session still
has a live process marker is never offered at all, because another terminal is
refreshing it, so it is that instance's live state rather than an orphaned
crash. Keeping (or dismissing) stays quiet for the rest of the run.

## Common paths

Project runtime data lives under `.goodvibes/` in the working directory. The
suite installer also sets `GOODVIBES_HOME` to
`~/.local/share/goodvibes-jev-data`, so global paths shown as `~/.goodvibes`
below resolve under that directory instead. A custom `--data-dir` relocates it.
The specific files worth knowing:

| Path | What it holds |
| --- | --- |
| `~/.goodvibes/tui/settings.json` | Global settings |
| `.goodvibes/tui/settings.json` | Project settings overriding the global layer |
| `~/.goodvibes/tui/secrets.enc` or `.goodvibes/tui/secrets.enc` | Encrypted secrets, global or per project |
| `~/.goodvibes/goodvibes.secrets.json` | Compatibility secrets read by older suite components |
| `.goodvibes/tui/services.json` | The service registry |
| `~/.goodvibes/daemon` | The daemon's own home and state directory |
| `~/.goodvibes/tui/providers/*.json` | Custom provider definitions, hot-reloaded |
| `.goodvibes/tui/automation-jobs.json` | Scheduled and automation jobs |
| `.goodvibes/tui/repl-history.json` | REPL history |
| `~/.goodvibes/tui/keybindings.json` | Keybinding overrides |
| `.goodvibes/agents/*.md` | Agent archetypes |
| `.goodvibes/mcp.json` | MCP server config |
| `.goodvibes/hooks.json` | Hook config (or the file named by `tools.hooksFile`) |

## First things to open in the product

These slash commands are the fastest way to get oriented once the TUI is running:

| Command | What it opens |
| --- | --- |
| `/model` | The fullscreen provider/model workspace for main chat, helper, tool LLM, and TTS LLM routing |
| `/settings` or `/config` | The fullscreen configuration workspace for inspecting and editing runtime settings |
| `/knowledge status` | The knowledge runtime's current posture |
| `/plugin browse` and `/marketplace` | The plugin ecosystem and the curated marketplace |
| `/remote` | Remote peers and node-host runners, if you use them |
| `/mcp` | Add, edit, remove, reload, and inspect MCP servers while the TUI is running |

## Local server discovery

Run `/scan` to discover local inference servers and register them as OpenAI-compatible providers. Discovery does not run automatically at startup; the scan probes well-known ports and, where a fixed port is not enough, the server's own response headers. Built-in discovery covers:

| Server | Identified by |
| --- | --- |
| Ollama | Port 11434 |
| LM Studio | Port 1234, or its fingerprint in headers or model ids |
| vLLM | `x-vllm-*` response headers |
| llama.cpp | `llama` in the `server` response header |
| LocalAI | `localai` in the `server` response header |
| Text Generation Inference (TGI) | `text-generation-inference` in response headers |
| Jan | Port 1337 |
| GPT4All | Port 4891 |
| KoboldCpp | Port 5001 |
| Aphrodite | Port 2242 |

Which servers get a dedicated adapter versus the generic OpenAI-compatible one is covered in [providers-and-routing.md](providers-and-routing.md).

## Related docs

- [Deployment and services](deployment-and-services.md)
- [Providers and routing](providers-and-routing.md)
- [Tools and commands](tools-and-commands.md)
