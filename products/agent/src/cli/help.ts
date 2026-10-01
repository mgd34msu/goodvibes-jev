import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../version.ts';
import { describeSelfUpdate, readLastSelfUpdate } from '../runtime/self-update-receipt.ts';
import { detectInstallKind } from '../runtime/update-check.ts';

function readJsonVersion(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

export function getPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readJsonVersion(join(here, '..', '..', 'package.json'))
    ?? VERSION;
}

/**
 * The version line, plus a plain statement when this binary replaced itself.
 *
 * `version` is where a person goes to find out which build they are holding, so
 * it is where "the build you installed is not the build running" has to be
 * said. Without it, a self-replacement was discoverable only as a stray
 * `.previous` file, which is how a verification round ended up measuring a
 * downloaded release instead of the binary it had just built.
 *
 * Reading is best-effort and takes the executable path as an argument: this
 * runs before any home directory, profile, or config is resolved, so the
 * receipt beside the executable is the only state it can consult.
 */
export function renderGoodVibesVersion(
  binary = 'goodvibes-agent',
  options: { readonly execPath?: string; readonly readReceipt?: typeof readLastSelfUpdate } = {},
): string {
  const line = `${binary} ${getPackageVersion()}`;
  const execPath = options.execPath ?? process.execPath;
  if (detectInstallKind(execPath) !== 'binary') return line;
  const receipt = (options.readReceipt ?? readLastSelfUpdate)(execPath);
  return receipt ? `${line}\n\n${describeSelfUpdate(receipt, execPath)}` : line;
}

export function renderGoodVibesHelp(binary = 'goodvibes-agent'): string {
  return [
    `Usage: ${binary} [OPTIONS] [PROMPT]`,
    `       ${binary} [OPTIONS] <COMMAND> [ARGS]`,
    '',
    'Primary use:',
    `  ${binary}                 Launch the interactive Agent TUI`,
    `  ${binary} setup           Open the Agent workspace`,
    '',
    'Inside the TUI:',
    '  /agent                    Open the operator workspace',
    '  /setup                    Open the Agent workspace',
    '  /model                    Choose provider and model',
    '  /knowledge                Use isolated Agent Knowledge',
    '  /notes                    Open Agent-local scratchpad notes',
    '  /vibe                    Inspect or create VIBE.md personality',
    '  /personas, /skills        Tune Agent-local behavior',
    '  /routines                 Run local routines in the main conversation',
    '  /schedule remind          Create confirmed reminders or inspect schedules',
    '  /delegate                 Explicitly hand build/fix/review work to GoodVibes TUI',
    '',
    'Scriptable mirrors:',
    '  run|exec [prompt]          Run non-interactively with text/json/stream-json output',
    '  status                     Print config, provider, auth, and setup posture',
    '  doctor                     Print status plus setup warnings',
    '  setup|onboarding [status]  Open the Agent workspace, or print setup status',
    '  models [provider]          List/use/pin selectable models and recent model history',
    '  providers                  List/inspect/use provider config/auth posture',
    '  profiles                   Manage isolated Agent profile homes',
    '  personas                   Manage local Agent personas',
    '  skills                     Manage local Agent skills and skill bundles',
    '  memory                     Manage Agent-owned durable memory records',
    '  routines                   Inspect local routines and explicitly promote one to a connected schedule',
    '  ci                         Check connected-host CI status and manage standing CI watches',
    '  principals                 Manage the connected-host cross-channel principal identity registry',
    '  owner-profile              Read, trace, correct, and delete what the platform knows about you',
    '  channel-profiles           Manage per-channel model/provider/permission-mode defaults',
    '  workspaces                 Manage which workspaces get automatic checkpoints',
    '  browser                    Drive a real browser from the shell (status|provision|open <url>|read <url>)',
    '  relay                      Report the connected host\'s outbound relay configuration (status|pair)',
    '  fleet                      Review and resolve this Agent\'s best-of-N attempt groups',
    '  auth                       Inspect Agent auth posture and connection token state',
    '  compat                     Inspect connected-host compatibility and Agent Knowledge route readiness',
    '  knowledge                  Use isolated Agent Knowledge routes',
    '  ask|search                 Shortcuts for isolated Agent Knowledge ask/search',
    '  delegate                   Explicitly delegate build/fix/review work to GoodVibes TUI',
    '  subscription               Start/finish/logout provider subscription sessions',
    '  secrets                    List, set, link, delete, and test GoodVibes secret refs',
    '  sessions                   List, show, export, or resume saved sessions',
    '  pair|qrcode                Print companion pairing payload and QR code',
    '  bundle export|inspect|import',
    '                             Move setup/profile/trust/support bundles',
    '  import openclaw [path]     Migrate an OpenClaw workspace (dry-run default, --apply to write)',
    '  completion <shell>         Generate shell completion script',
    '  help [command]             Print this help or command-specific help',
    '  version                    Print version',
    '',
    'Options:',
    '  -m, --model <registryKey>       Override model. provider:model infers --provider',
    '      --provider <id>            Override provider',
    '      --agent-profile <name>     Use an isolated Agent profile home',
    '      --runtime-url <url>        Connected GoodVibes API root',
    '  -C, --cd <dir>                 Set working directory for this launch',
    '      --working-dir <dir>        Alias for --cd',
    '  -c, --config <key=value>       Override a config value for this launch',
    '      --enable <feature>         Enable a feature flag for this launch',
    '      --disable <feature>        Disable a feature flag for this launch',
    '  -p, --prompt <text>            Run a non-interactive prompt',
    '      --print                    Alias for non-interactive run mode',
    '  -o, --output <format>          text, json, or stream-json',
    '      --output-format <format>   Alias for --output',
    '      --json                     Alias for --output-format json',
    '      --no-alt-screen            Keep output in normal terminal scrollback',
    '  -r, --resume [id|latest]       Resume saved session when supported',
    '  -s, --session <id>             Use a specific session when supported',
    '      --continue                 Continue the latest session when supported',
    '      --fork                     Fork session when supported',
    '  -h, --help                     Print help',
    '  -v, --version                  Print version',
    '',
    'Examples:',
    `  ${binary}`,
    `  ${binary} --no-alt-screen`,
    `  ${binary} --cd ~/work/project --model openai:gpt-5.2`,
    `  ${binary} setup`,
    `  ${binary} setup status`,
    `  ${binary} status`,
    `  ${binary} --runtime-url http://127.0.0.1:3421 status`,
    `  ${binary} models current`,
    `  ${binary} models use openai:gpt-5.2`,
    `  ${binary} providers inspect openai`,
    `  ${binary} profiles create household --template household --yes`,
    `  ${binary} --agent-profile household`,
    `  ${binary} personas create --name "Travel Planner" --description "Plan trips" --body "Compare options before booking"`,
    `  ${binary} skills create --name "Daily Brief" --description "Summarize operator state" --procedure "Review Agent Knowledge, work plans, approvals, and routines" --requires-env GOODVIBES_AGENT_TOKEN --requires-command gh --enabled`,
    `  ${binary} memory add fact "Prefers concise morning briefings" --scope project --tags preference`,
    `  ${binary} memory search "morning briefings"`,
    `  ${binary} routines promote daily-operations-sweep --cron "0 9 * * *" --timezone America/Chicago --yes`,
    `  ${binary} ci status my-org/my-repo --ref main`,
    `  ${binary} ci watches create my-org/my-repo --ref main --delivery-channel slack:C123 --yes`,
    `  ${binary} principals resolve --channel slack --value U123`,
    `  ${binary} owner-profile read`,
    `  ${binary} owner-profile provenance commerce.shippingAddress`,
    `  ${binary} channel-profiles set slack --model openai:gpt-5.4 --permission-mode plan --yes`,
    `  ${binary} fleet attempts list`,
    `  ${binary} compat`,
    `  ${binary} knowledge status`,
    `  ${binary} knowledge ask "What is GoodVibes Agent?"`,
    `  ${binary} ask "What is GoodVibes Agent?"`,
    `  ${binary} search "release checklist"`,
    `  ${binary} delegate --review "fix the failing tests in ~/work/project"`,
    `  ${binary} subscription providers`,
    `  ${binary} subscription login openai start --open`,
    `  ${binary} pair`,
    `  ${binary} routines list`,
  ].join('\n');
}

type CommandHelp = {
  readonly usage: readonly string[];
  readonly summary: string;
  readonly subcommands?: readonly string[];
  readonly examples?: readonly string[];
};

export interface GoodVibesCommandHelpDescriptor {
  readonly command: string;
  readonly aliases: readonly string[];
  readonly summary: string;
  readonly usage: readonly string[];
  readonly subcommands: readonly string[];
  readonly examples: readonly string[];
}

const COMMAND_HELP: Record<string, CommandHelp> = {
  run: {
    usage: ['run [prompt] [--output text|json|stream-json]', 'exec [prompt]'],
    summary: 'Run a single non-interactive agent turn and write the result to stdout.',
    examples: ['run "summarize the current project"', 'run --output json "list risks"', 'exec --output stream-json "check runtime status"'],
  },
  setup: {
    usage: ['setup', 'setup status', 'onboarding', 'onboarding status'],
    summary: 'Open the Agent workspace, or inspect whether setup has already been applied for this user.',
    examples: ['setup', 'setup status', 'onboarding status'],
  },
  status: {
    usage: ['status', 'status --json', '--runtime-url http://127.0.0.1:3421 status'],
    summary: 'Print Agent config, provider, auth, connected-host state, and setup posture.',
    examples: ['status', 'status --json', '--runtime-url http://127.0.0.1:3421 status'],
  },
  doctor: {
    usage: ['doctor', 'doctor --json', '--runtime-url http://127.0.0.1:3421 doctor'],
    summary: 'Print status plus actionable setup warnings with cause, impact, and next action.',
    examples: ['doctor', 'doctor --json', '--runtime-url http://127.0.0.1:3421 doctor'],
  },
  providers: {
    usage: ['providers [list]', 'providers current', 'providers inspect <provider>', 'providers use <provider> [modelRegistryKey]'],
    summary: 'Inspect and change provider setup, auth posture, model counts, and setup class.',
    examples: ['providers', 'providers inspect openai-subscriber', 'providers use openai openai:gpt-5.4'],
  },
  profiles: {
    usage: ['profiles list', 'profiles default', 'profiles use <name> --yes', 'profiles default clear --yes', 'profiles templates', 'profiles templates from-discovered <id> --yes', 'profiles create-from-discovered <name> --yes', 'profiles templates export <id> <path> --yes', 'profiles templates import <path> --yes', 'profiles show <name>', 'profiles create <name> [--template <id>] --yes', 'profiles delete <name> --yes', '--agent-profile <name>'],
    summary: 'Create and inspect isolated Agent profile homes, with starter templates for household, research, travel, operations, personal productivity, and local imported starters. A profile changes Agent-local config, sessions, memory, personas, skills, routines, and setup paths without changing the connected GoodVibes host.',
    examples: ['profiles templates', 'profiles create household --template household --yes', 'profiles use household --yes', 'profiles default', 'profiles create-from-discovered research-desk --yes', 'profiles templates from-discovered research-desk --yes', 'profiles templates export research ./research-starter.json --yes', 'profiles templates import ./research-starter.json --yes', '--agent-profile household status'],
  },
  personas: {
    usage: [
      'personas list',
      'personas active',
      'personas discover',
      'personas import-discovered <name> [--use] --yes',
      'personas search <query>',
      'personas show <id>',
      'personas create --name <name> --description <summary> --body <instructions> [--tags a,b] [--triggers a,b] [--use]',
      'personas update <id> [--name <name>] [--description <summary>] [--body <instructions>] [--tags a,b] [--triggers a,b]',
      'personas use <id>',
      'personas clear',
      'personas review <id>',
      'personas stale <id> <reason>',
      'personas delete <id> --yes',
    ],
    summary: 'Manage Agent-local personas for the serial main conversation. Personas do not create separate Agent jobs.',
    examples: [
      'personas list',
      'personas discover',
      'personas import-discovered "Travel Planner" --use --yes',
      'personas create --name "Travel Planner" --description "Plan trips" --body "Compare options before booking" --use',
      'personas review travel-planner',
      'personas delete travel-planner --yes',
    ],
  },
  skills: {
    usage: [
      'skills list',
      'skills enabled',
      'skills active',
      'skills attention',
      'skills discover',
      'skills import-discovered <name> [--enabled] --yes',
      'skills search <query>',
      'skills show <id>',
      'skills create --name <name> --description <summary> --procedure <steps> [--tags a,b] [--triggers a,b] [--requires-env A,B] [--requires-command gh,jq] [--enabled]',
      'skills update <id> [--name <name>] [--description <summary>] [--procedure <steps>] [--tags a,b] [--triggers a,b] [--requires-env A,B] [--requires-command gh,jq]',
      'skills enable <id>',
      'skills disable <id>',
      'skills review <id>',
      'skills stale <id> <reason>',
      'skills delete <id> --yes',
      'skills bundle [list|enabled|attention|show|create|update|enable|disable|review|stale|delete]',
    ],
    summary: 'Manage reusable Agent-local procedures and skill bundles for the main conversation.',
    examples: [
      'skills list',
      'skills attention',
      'skills bundle attention',
      'skills discover',
      'skills import-discovered "Daily Brief" --enabled --yes',
      'skills create --name "Daily Brief" --description "Summarize operator state" --procedure "Review Agent Knowledge, work plans, approvals, and routines" --requires-env GOODVIBES_AGENT_TOKEN --requires-command gh --enabled',
      'skills bundle create --name "Ops Pack" --description "Daily operations bundle" --skills daily-brief --enabled',
      'skills delete daily-brief --yes',
    ],
  },
  memory: {
    usage: [
      'memory list [class] [--scope session|project|team] [--limit <n>]',
      'memory search <query> [--semantic] [--cls <class>] [--scope <scope>] [--limit <n>]',
      'memory add <class> <summary> [--scope <scope>] [--detail <text>] [--tags a,b] [--confidence <0-100>]',
      'memory show <id>',
      'memory queue [limit]',
      'memory review <id> <fresh|reviewed|stale|contradicted> [--confidence <0-100>] [--by <name>] [--reason <text>]',
      'memory stale <id> <reason>',
      'memory contradict <id> <reason>',
      'memory promote <id> <session|project|team> --yes',
      'memory link <fromId> <toId> <relation> --yes',
      'memory delete <id> --yes',
      'memory export <path> [--scope <scope>] [--cls <class>] --yes',
      'memory import <path> --yes',
      'memory handoff-inspect <path>',
      'memory vector [status|doctor|rebuild]',
    ],
    summary: 'Manage Agent-owned durable memory. This uses the Agent memory store only; it never falls back to default knowledge or non-Agent knowledge segments.',
    examples: [
      'memory list',
      'memory add fact "Prefers concise morning briefings" --scope project --tags preference',
      'memory search "morning briefings"',
      'memory review mem-1 reviewed --confidence 92',
      'memory export ./agent-memory.json --scope project --yes',
      'memory delete mem-1 --yes',
    ],
  },
  routines: {
    usage: [
      'routines list',
      'routines enabled',
      'routines attention',
      'routines discover',
      'routines import-discovered <name> [--enabled] --yes',
      'routines show <id>',
      'routines create --name <name> --description <summary> --steps <steps> [--tags a,b] [--triggers a,b] [--requires-env A,B] [--requires-command gh,jq] [--enabled]',
      'routines receipts',
      'routines reconcile',
      'routines receipt <receipt-id>',
      'routines promote <id> (--cron <expr>|--every <interval>|--at <iso-time>) [--timezone <tz>] [--name <schedule-name>] [--provider <id>] [--model <model>] [--delivery-channel <channel[:route[:label]]>|--delivery-route <route[:label]>|--delivery-webhook <url>|--delivery-link <url>] [--disabled] --yes',
    ],
    summary: 'Inspect, create, and import Agent-local routines with setup readiness. The same routine workflow is available in the TUI through /routines and the Agent workspace. GoodVibes schedule promotion is explicit. Without --yes, promotion only prints the preview.',
    examples: [
      'routines list',
      'routines attention',
      'routines discover',
      'routines import-discovered "Daily Brief" --enabled --yes',
      'routines show daily-operations-sweep',
      'routines create --name "Daily Sweep" --description "Review operator state" --steps "Check tasks, approvals, channels, and Agent Knowledge" --requires-env GOODVIBES_AGENT_TOKEN',
      'routines receipts',
      'routines reconcile',
      'routines promote daily-operations-sweep --cron "0 9 * * *" --timezone America/Chicago --delivery-channel slack --yes',
      'routines promote weekly-review --every 7d --disabled',
    ],
  },
  models: {
    usage: ['models [provider]', 'models current', 'models use <registryKey>', 'models pin <registryKey>', 'models recent'],
    summary: 'List, inspect, select, pin, and review model choices.',
    examples: ['models current', 'models openai', 'models use openai:gpt-5.4'],
  },
  ci: {
    usage: [
      'ci status <repo> [--ref <ref>] [--pr <number>]',
      'ci watches list',
      'ci watches create <repo> --delivery-channel <channel> [--ref <ref>] [--pr <number>] [--trigger-fix-session] --yes',
      'ci watches delete <watchId> --yes',
      'ci watches run <watchId>',
    ],
    summary: 'Check per-job CI status on the connected host and manage standing CI watches. Status is always rendered per job (name, status, conclusion), never collapsed to a single rollup.',
    examples: [
      'ci status my-org/my-repo --ref main',
      'ci status my-org/my-repo --pr 42',
      'ci watches list',
      'ci watches create my-org/my-repo --ref main --delivery-channel slack:C123 --yes',
      'ci watches run watch-123',
      'ci watches delete watch-123 --yes',
    ],
  },
  principals: {
    usage: [
      'principals list',
      'principals get <id>',
      'principals create --name <name> --kind <user|bot|service|token> [--identity channel:value,channel:value] --yes',
      'principals update <id> [--name <name>] [--kind <kind>] [--identity channel:value,channel:value] --yes',
      'principals delete <id> --yes',
      'principals resolve --channel <channel> --value <value>',
    ],
    summary: 'Manage the connected-host cross-channel principal identity registry, mapping channel-specific sender identities (a Slack user id, an email address, a phone number) onto one named principal. resolve reports known: false rather than asserting a match when no identity is mapped.',
    examples: [
      'principals list',
      'principals create --name "Mike Davis" --kind user --identity slack:U123,email:mike@example.com --yes',
      'principals resolve --channel slack --value U123',
      'principals delete principal-1 --yes',
    ],
  },
  'owner-profile': {
    usage: [
      'owner-profile read',
      'owner-profile get <fieldId>',
      'owner-profile person <name> --named-by "<your words>"',
      'owner-profile provenance <fieldId>',
      'owner-profile set <fieldId> <value> [--said "<your words>"] --yes',
      'owner-profile forget <fieldId> --yes',
      'owner-profile forget --section <section> --text "<the line, exactly>" --yes',
      'owner-profile status',
    ],
    summary: 'Read, trace, correct, and delete the owner profile the daemon keeps: one Markdown file holding your name, contact, location, commerce, preferences, people, places, work, and notes. read prints the whole document with the provenance suffix on every learned line; get prints one field; person prints one person by name and takes the words you used that pointed at them; provenance answers "where did you get that" for one field, including the values it superseded; set supersedes a field and keeps the old one; forget deletes a line and its kept history, and reports that a field was not there rather than reporting success; a prose line is named by its section and exact text, never by position, because you edit this file yourself and a position from an earlier read can point at a different line by now; status prints load state, path, counts, and any field whose value did not parse: never values.',
    examples: [
      'owner-profile read',
      'owner-profile provenance commerce.shippingAddress',
      'owner-profile person Sarah --named-by "email my sister the tickets"',
      'owner-profile set location.timezone America/Detroit --yes',
      'owner-profile forget contact.phone --yes',
      'owner-profile status',
    ],
  },
  'channel-profiles': {
    usage: [
      'channel-profiles list',
      'channel-profiles get <surfaceKind> [--channel-id <id>]',
      'channel-profiles set <surfaceKind> [--channel-id <id>] [--model <model>] [--provider <provider>] [--permission-mode <plan|normal|accept-edits|auto>] --yes',
      'channel-profiles delete <surfaceKind> [--channel-id <id>] --yes',
    ],
    summary: 'Manage per-channel default model, provider, and permission-mode bindings applied to sessions that channel originates.',
    examples: [
      'channel-profiles list',
      'channel-profiles set slack --model openai:gpt-5.4 --permission-mode plan --yes',
      'channel-profiles get slack',
      'channel-profiles delete slack --yes',
    ],
  },
  workspaces: {
    usage: [
      'workspaces list',
      'workspaces register [path] [--label <label>] --yes',
      'workspaces unregister [path] --yes',
    ],
    summary: 'Manage the registered-workspace list that gates automatic (turn-end/lifecycle) checkpoints. A workspace not in this list gets no automatic checkpoints; path defaults to the current working directory.',
    examples: [
      'workspaces list',
      'workspaces register --yes',
      'workspaces register /home/mike/Projects/goodvibes-agent --label agent --yes',
      'workspaces unregister --yes',
    ],
  },
  browser: {
    usage: [
      'browser status',
      'browser provision [--repair]',
      'browser open <url> [--visible]',
      'browser read <url> [--visible]',
    ],
    summary: 'Drive a real browser from the shell, through the same tool the model calls. `status` reports whether the driver and browser are present and, when they are not, exactly what is missing and what to do; `provision` performs the one-act setup with every step visible; `open` and `read` prove the whole path on a real page without needing a model, a provider, or an API key.',
    examples: [
      'browser status',
      'browser provision',
      'browser open https://example.com',
      'browser read https://example.com',
    ],
  },
  relay: {
    usage: [
      'relay status',
      'relay pair',
    ],
    summary: 'Report the connected GoodVibes host\'s imported relay.* configuration and the relay-connect feature flag. Agent hosts no daemon itself, so this is not a live check, and relay pair honestly refuses, pairing payloads are minted by whichever daemon holds the relay identity key.',
    examples: [
      'relay status',
      'relay pair',
    ],
  },
  fleet: {
    usage: [
      'fleet attempts list [--workstream <workstreamId>]',
      'fleet attempts pick <groupId> <winnerItemId> --yes',
      'fleet attempts judge <groupId>',
    ],
    summary: 'Review and resolve this Agent\'s own best-of-N attempt groups (orchestration engine state, disk-persisted, not a connected-host call): siblings that ran in isolated worktrees and are held for a winner pick instead of auto-merging. judge runs the optional judge model and PROPOSES a winner (clearly labeled as a model proposal, never an auto-decision); pick is the confirm-gated action that actually merges the winner and cleans losing worktrees.',
    examples: [
      'fleet attempts list',
      'fleet attempts list --workstream workstream-1',
      'fleet attempts judge group-1',
      'fleet attempts pick group-1 item-2 --yes',
    ],
  },
  auth: {
    usage: ['auth', 'auth status', 'auth review', 'auth users', 'auth sessions'],
    summary: 'Inspect Agent auth posture and connection token state. Runtime user/session administration stays outside Agent.',
    examples: ['auth', 'auth status', 'auth users'],
  },
  compat: {
    usage: ['compat', 'compat --json'],
    summary: 'Inspect connected-host compatibility and Agent-specific knowledge route readiness.',
    examples: ['compat', 'compat --json'],
  },
  knowledge: {
    usage: [
      'knowledge status',
      'knowledge ask <question> [--limit <n>] [--mode concise|standard|detailed]',
      'knowledge search <query> [--limit <n>]',
      'knowledge list [--kind sources|nodes|issues] [--limit <n>]',
      'knowledge get <id>',
      'knowledge connectors [connectorId|doctor <connectorId>]',
      'knowledge ingest-url <url> [--title <title>] [--tags a,b] --yes',
      'knowledge ingest-file <path> [--title <title>] [--tags a,b] --yes',
      'knowledge ingest-artifact <artifactId> [--title <title>] [--tags a,b] --yes',
      'knowledge ingest-connector <connectorId> [--input <json-or-text>|--path <path>|--content <text>] --yes',
      'knowledge import-urls <path> --yes',
      'knowledge import-bookmarks <path> --yes',
      'knowledge import-browser-history [--browsers chrome,firefox] [--sources history,bookmark] --yes',
      'knowledge reindex --yes',
    ],
    summary: 'Call isolated Agent Knowledge routes under /api/goodvibes-agent/knowledge. No default knowledge or non-Agent fallback.',
    examples: [
      'knowledge status',
      'knowledge ask "What is GoodVibes Agent?"',
      'knowledge search "release checklist"',
      'knowledge list --kind sources',
      'knowledge connectors',
      'knowledge connectors doctor url',
      'knowledge ingest-url https://example.com/page --title "Reference" --yes',
      'knowledge ingest-file ./docs/guide.md --title "Guide" --yes',
      'knowledge ingest-artifact artifact-123 --title "Reviewed Export" --yes',
      'knowledge ingest-connector url --input https://example.com/reference --yes',
      'knowledge import-urls ~/agent-links.txt --yes',
      'knowledge import-browser-history --browsers chrome,firefox --sources history,bookmark --yes',
    ],
  },
  ask: {
    usage: ['ask <question> [--limit <n>] [--mode concise|standard|detailed]'],
    summary: 'Shortcut for isolated Agent Knowledge ask. This never queries default knowledge or non-Agent knowledge.',
    examples: ['ask "What is GoodVibes Agent?"', 'ask "release checklist" --mode concise'],
  },
  search: {
    usage: ['search <query> [--limit <n>]'],
    summary: 'Shortcut for isolated Agent Knowledge search. This never queries default knowledge or non-Agent knowledge.',
    examples: ['search "release checklist"', 'search "operator workspace" --limit 5'],
  },
  delegate: {
    usage: ['delegate [--review] <build/fix/review task>'],
    summary: 'Create one shared-session task request for GoodVibes TUI. Delegated review is requested with --review.',
    examples: [
      'delegate "fix the failing tests in this repo"',
      'delegate --review "implement the settings screen and review it"',
    ],
  },
  subscription: {
    usage: ['subscription list', 'subscription providers', 'subscription inspect <provider>', 'subscription login <provider> start [--open]', 'subscription login <provider> finish <code-or-url>', 'subscription logout <provider>'],
    summary: 'Manage OAuth/subscription-backed provider sessions such as OpenAI subscription access.',
    examples: ['subscription providers', 'subscription login openai start --open', 'subscription inspect openai'],
  },
  secrets: {
    usage: ['secrets list', 'secrets providers', 'secrets test goodvibes://secrets/<source>/...', 'secrets set <KEY> <value>', 'secrets link <KEY> <ref>'],
    summary: 'Manage GoodVibes secret records and secret references. Secret refs never embed secret values.',
    examples: ['secrets providers', 'secrets test goodvibes://secrets/env/OPENAI_API_KEY', 'secrets link OPENAI_API_KEY goodvibes://secrets/env/OPENAI_API_KEY'],
  },
  sessions: {
    usage: ['sessions list', 'sessions show <id|name>', 'sessions export <id|name> [path]', 'sessions resume <id|name>'],
    summary: 'List, inspect, export, or resume saved Agent terminal sessions.',
    examples: ['sessions list', 'sessions show latest-session', 'sessions export abc123 session.json'],
  },
  tasks: {
    usage: ['tasks list', 'tasks show <taskId>'],
    summary: 'Inspect connected-host task summaries. Agent blocks host-owned task submission; use run for one-shot work or delegate for explicit build/fix/review handoff.',
    examples: ['tasks list', 'tasks show task-123', 'run "check provider readiness"', 'delegate "fix the failing tests"'],
  },
  bundle: {
    usage: ['bundle export [path]', 'bundle inspect <path>', 'bundle import <path>'],
    summary: 'Export, inspect, or import setup/profile/trust/support bundle data.',
    examples: ['bundle export goodvibes-agent-bundle.json', 'bundle inspect goodvibes-agent-bundle.json'],
  },
  pair: {
    usage: ['pair', 'qrcode'],
    summary: 'Print companion pairing connection details and a QR code.',
    examples: ['pair', 'qrcode'],
  },
  import: {
    usage: ['import openclaw [path] [--apply]'],
    summary: 'Migrate an OpenClaw workspace into the Agent registries. Dry-run is the default; it prints the personas, memory records, skills, and permission allowlist categories that would be created, plus any skipped files with reasons. Re-run with --apply to write through the persona registry, the canonical memory store, the skill registry, and the permission settings. Reads ~/.openclaw by default, or a supplied path.',
    examples: [
      'import openclaw',
      'import openclaw ~/.openclaw',
      'import openclaw ~/.openclaw --apply',
    ],
  },
  completion: {
    usage: ['completion <bash|zsh|fish>'],
    summary: 'Generate shell completion scripts.',
    examples: ['completion bash', 'completion zsh'],
  },
};

const HELP_ALIASES: Record<string, string> = {
  exec: 'run',
  e: 'run',
  onboarding: 'setup',
  compatibility: 'compat',
  provider: 'providers',
  model: 'models',
  profile: 'profiles',
  persona: 'personas',
  skill: 'skills',
  'agent-skills': 'skills',
  memories: 'memory',
  routine: 'routines',
  principal: 'principals',
  'owner-profiles': 'owner-profile',
  'about-me': 'owner-profile',
  'channel-profile': 'channel-profiles',
  workspace: 'workspaces',
  fleets: 'fleet',
  know: 'knowledge',
  kb: 'knowledge',
  find: 'search',
  build: 'delegate',
  subscriptions: 'subscription',
  secret: 'secrets',
  session: 'sessions',
  task: 'tasks',
  bundles: 'bundle',
  qrcode: 'pair',
  qr: 'pair',
  migrate: 'import',
  completions: 'completion',
};

export function listGoodVibesHelpTopics(): readonly string[] {
  return Object.keys(COMMAND_HELP).sort();
}

function normalizeHelpTopic(topic: string): string {
  const normalized = topic.trim().toLowerCase();
  return HELP_ALIASES[normalized] ?? normalized;
}

export function hasGoodVibesCommandHelp(topic: string): boolean {
  return COMMAND_HELP[normalizeHelpTopic(topic)] !== undefined;
}

export function describeGoodVibesCommandHelp(topic: string): GoodVibesCommandHelpDescriptor | null {
  const normalized = normalizeHelpTopic(topic);
  const help = COMMAND_HELP[normalized];
  if (!help) return null;
  return {
    command: normalized,
    aliases: Object.entries(HELP_ALIASES)
      .filter(([, target]) => target === normalized)
      .map(([alias]) => alias)
      .sort(),
    summary: help.summary,
    usage: help.usage,
    subcommands: help.subcommands ?? [],
    examples: help.examples ?? [],
  };
}

export function renderGoodVibesCommandHelp(topic: string, binary = 'goodvibes-agent'): string {
  const normalized = normalizeHelpTopic(topic);
  const help = COMMAND_HELP[normalized];
  if (!help) {
    return [
      `No detailed help is available for "${topic}".`,
      '',
      renderGoodVibesHelp(binary),
    ].join('\n');
  }
  return [
    `GoodVibes Agent ${normalized}`,
    '',
    help.summary,
    '',
    'Usage:',
    ...help.usage.map((usage) => `  ${binary} ${usage}`),
    ...(help.subcommands && help.subcommands.length > 0 ? [
      '',
      'Subcommands:',
      ...help.subcommands.map((subcommand) => `  ${subcommand}`),
    ] : []),
    ...(help.examples && help.examples.length > 0 ? [
      '',
      'Examples:',
      ...help.examples.map((example) => `  ${binary}${example ? ` ${example}` : ''}`),
    ] : []),
  ].join('\n');
}
