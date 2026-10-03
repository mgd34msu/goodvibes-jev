import { agentHarnessModes, hostActions, settingsActions } from './agent-harness-route-format.ts';
export { describeCliCommandPolicy } from './agent-harness-cli-command-policy.ts';
// Re-exported so this module stays the one import site for harness metadata,
// exactly as describeCliCommandPolicy above already is.
export {
  blockedConnectedHostCapabilities,
  connectedHostCapabilityMap,
  connectedHostRouteFamilies,
  connectedHostSummary,
  describeConnectedHostCapability,
} from './agent-harness-connected-host-capabilities.ts';
export type { ConnectedHostCapabilityResolution } from './agent-harness-connected-host-capabilities.ts';

export interface CommandExecutionPolicy {
  readonly effect: 'read-only' | 'local-state' | 'connected-host-state' | 'external-network' | 'ui-navigation' | 'session-lifecycle' | 'delegated-work' | 'mixed' | 'unknown';
  readonly confirmation: string;
  readonly preferredModelTool?: string;
  readonly boundary: string;
}

export function describeCommandPolicy(commandName: string): CommandExecutionPolicy {
  const root = commandName.replace(/^\//, '').trim().toLowerCase();
  const confirmation = 'agent_harness mode:"run_command" requires confirm:true and explicitUserRequest for every slash command invocation.';
  if (root === 'agent' || root === 'agent-workspace' || root === 'workspace') {
    return {
      effect: 'ui-navigation',
      confirmation,
      preferredModelTool: agentHarnessModes('workspace', 'workspace_categories', 'workspace_actions', 'workspace_action', 'run_workspace_action'),
      boundary: 'Agent workspace navigation is visible shell routing. Use workspace action modes for concrete model-readable operation.',
    };
  }
  if (root === 'setup' || root === 'welcome') {
    return {
      effect: 'ui-navigation',
      confirmation,
      preferredModelTool: agentHarnessModes('workspace_actions', 'workspace_action', 'open_ui_surface'),
      boundary: 'Setup opens the visible Agent workspace. Model-side changes should use settings or workspace actions.',
    };
  }
  if (root === 'commands' || root === 'help' || root === 'shortcuts') {
    return {
      effect: 'ui-navigation',
      confirmation,
      preferredModelTool: root === 'shortcuts' ? agentHarnessModes('shortcuts', 'keybindings', 'keybinding') : agentHarnessModes('commands', 'command'),
      boundary: 'Discovery commands open visible help surfaces. The model should inspect the matching harness catalog directly before invoking commands.',
    };
  }
  if (root === 'keybindings') {
    return {
      effect: 'read-only',
      confirmation,
      preferredModelTool: agentHarnessModes('shortcuts', 'keybindings', 'keybinding', 'run_keybinding', 'set_keybinding', 'reset_keybinding'),
      boundary: 'Keybinding inspection is read-only. Keybinding execution or edits require explicit confirmation through agent_harness keybinding modes.',
    };
  }
  if (root === 'payments') {
    return {
      effect: 'connected-host-state',
      confirmation,
      preferredModelTool: settingsActions('list', 'get', 'set'),
      boundary: 'Budgets, windows, CVV handling and the two addresses are ordinary daemon-owned settings and can be read or written through the settings adapter. The card itself cannot: number, expiry, verification code and cardholder name are typed only by the person at a local terminal, through a masked prompt that echoes nothing, and are stored write-only in the daemon secret store. Nothing here returns them and nothing here sets them, and no card prompt is ever offered over Telegram, ntfy, Discord, Slack, WhatsApp, Signal or a webhook, approving or cancelling a purchase over those channels still works.',
    };
  }
  if (root === 'settings' || root === 'config') {
    return {
      effect: 'mixed',
      confirmation,
      preferredModelTool: settingsActions('list', 'get', 'set', 'reset', 'import'),
      boundary: 'Settings can be changed through the first-class settings adapter, including daemon-owned ones, a write routes to the runtime that owns the key and reports the store it landed in. A short list of keys that turn off approval gates, weaken the exec sandbox, or expose this host to the network needs the user to ask first; the refusal names the key and says why.',
    };
  }
  if (root === 'model' || root === 'effort') {
    return {
      effect: 'mixed',
      confirmation,
      preferredModelTool: `${settingsActions('get', 'set')} or ${agentHarnessModes('open_ui_surface')}`,
      boundary: 'Model and reasoning-effort changes affect the current Agent chat route. Prefer settings for concrete values and UI surface routing for visible pickers.',
    };
  }
  if (root === 'provider' || root === 'providers') {
    return {
      effect: 'mixed',
      confirmation,
      preferredModelTool: `${settingsActions('get', 'set')} or ${agentHarnessModes('open_ui_surface')}`,
      boundary: 'Provider selection and custom provider files belong to Agent provider configuration. Adding, removing, or switching providers requires explicit user intent.',
    };
  }
  if (root === 'network-scan' || root === 'discover-lan') {
    return {
      effect: 'local-state',
      confirmation,
      preferredModelTool: settingsActions('get', 'set'),
      boundary: 'Turns the local-network model-server scan on or off and persists that decision to a local consent file; it never probes the network itself. Enabling it requires the user\'s explicit request, do not turn it on unprompted.',
    };
  }
  if (root === 'refresh-models') {
    return {
      effect: 'external-network',
      confirmation,
      preferredModelTool: `${settingsActions('list', 'get')} or ${agentHarnessModes('tools')}`,
      boundary: 'Model catalog refresh may call provider discovery routes and update local provider metadata. Do not run it without explicit user request.',
    };
  }
  if (root === 'pin' || root === 'unpin') {
    return {
      effect: 'local-state',
      confirmation,
      preferredModelTool: agentHarnessModes('run_command'),
      boundary: 'Pinned model changes mutate local Agent provider preferences only and require an explicit model id.',
    };
  }
  if (root === 'mode') {
    return {
      effect: 'local-state',
      confirmation,
      preferredModelTool: settingsActions('get', 'set'),
      boundary: 'Interaction-mode changes affect the current Agent operator notification posture and should be explicit.',
    };
  }
  if (root === 'vibe' || root === 'vibes') {
    return {
      effect: 'local-state',
      confirmation,
      preferredModelTool: 'vibe or agent_local_registry',
      boundary: 'VIBE.md status/show are read-only; init writes a local personality file and import-persona writes an Agent-local persona after explicit confirmation.',
    };
  }
  if (root === 'brief') {
    return {
      effect: 'read-only',
      confirmation,
      preferredModelTool: 'agent_operator_briefing',
      boundary: 'Briefing reads current Agent operator posture and next actions without mutating connected-host state.',
    };
  }
  if (root === 'context') {
    return {
      effect: 'mixed',
      confirmation,
      preferredModelTool: agentHarnessModes('open_ui_surface', 'run_command'),
      boundary: '/context (the usage breakdown) and /context window (the current model\'s window) only read. /context window <size> writes a context window override for the current model and /context window clear removes it and any learned limit; both change the model registry\'s persisted override file in the local config directory and need explicit user intent.',
    };
  }
  if (root === 'health' || root === 'compat' || root === 'status' || root === 'accounts' || root === 'security') {
    return {
      effect: 'read-only',
      confirmation,
      preferredModelTool: root === 'compat'
        ? hostActions('services', 'service', 'status')
        : `${hostActions('services', 'service', 'status')} or ${settingsActions('list', 'get')} or ${agentHarnessModes('tools', 'open_ui_surface')}`,
      boundary: 'Diagnostics and review commands inspect Agent, provider, MCP, security, and connected-host readiness without taking lifecycle ownership.',
    };
  }
  if (root === 'update' || root === 'upgrade') {
    return {
      effect: 'mixed',
      confirmation,
      preferredModelTool: agentHarnessModes('run_command'),
      boundary: 'Check is a read-only release lookup; apply downloads, checksum-verifies, and atomically swaps the installed binary (and vector addon) keeping the previous version beside it, and rollback exchanges the kept previous version back in. Apply and rollback change the installed program and require explicit user intent.',
    };
  }
  if (root === 'trust' || root === 'auth' || root === 'bundle') {
    return {
      effect: 'mixed',
      confirmation,
      preferredModelTool: agentHarnessModes('run_command'),
      boundary: 'Review subcommands are read-only; bundle export/import or auth/trust bundle export writes local files and requires explicit confirmation.',
    };
  }
  if (root === 'mcp' || root === 'voice' || root === 'subscription' || root === 'secrets' || root === 'secret') {
    return {
      effect: 'mixed',
      confirmation,
      preferredModelTool: root === 'secrets' || root === 'secret'
        ? settingsActions('list', 'get', 'set', 'reset')
        : `${agentHarnessModes('workspace_actions', 'open_ui_surface')} or ${settingsActions('list', 'get', 'set')}`,
      boundary: 'Harness-owned configuration, secret, voice, subscription, and MCP commands can expose credentials or external account state. Mutations require explicit user intent and should prefer secret refs over raw values.',
    };
  }
  if (
    root === 'memory'
    || root === 'memories'
    || root === 'note'
    || root === 'persona'
    || root === 'personas'
    || root === 'skill'
    || root === 'skills'
    || root === 'routine'
    || root === 'routines'
  ) {
    return {
      effect: 'local-state',
      confirmation,
      preferredModelTool: 'agent_local_registry',
      boundary: 'Agent-local library records only unless the invoked command explicitly promotes to a connected schedule or Agent Knowledge source.',
    };
  }
  if (root === 'owner-profile' || root === 'about-me') {
    return {
      // Reads print his own profile; set and forget change the file and already
      // require --yes at the command itself. The model's route is the `profile`
      // tool, not this command: the tool carries the authority naming where a
      // fact came from, his verbatim words, and the one-line disclosure that
      // goes back in the reply, none of which a shell string can express.
      effect: 'mixed',
      confirmation,
      preferredModelTool: 'profile',
      boundary: 'The owner profile is one Markdown file at daemon scope that only the daemon writes. Reads are safe; every write carries an authority and is refused unless the fact came from him directly. Record facts through the `profile` tool during a conversation rather than invoking this command.',
    };
  }
  if (root === 'notes') {
    return {
      effect: 'ui-navigation',
      confirmation,
      preferredModelTool: `${agentHarnessModes('workspace_actions', 'workspace_action', 'run_workspace_action')} or agent_local_registry`,
      boundary: 'Notes workspace routing is visible navigation; note record mutations should use Agent-local registry or workspace action modes.',
    };
  }
  if (root === 'knowledge') {
    return {
      effect: 'mixed',
      confirmation,
      preferredModelTool: 'agent_knowledge or agent_knowledge_ingest',
      boundary: 'Agent Knowledge only. Do not use default knowledge or non-Agent knowledge spaces.',
    };
  }
  if (root === 'approval' || root === 'approvals' || root === 'automation') {
    return {
      effect: 'connected-host-state',
      confirmation,
      preferredModelTool: 'agent_operator_action',
      boundary: 'Only explicit allowlisted approval and automation operator actions should be performed from the model.',
    };
  }
  if (root === 'ci' || root === 'principals' || root === 'principal' || root === 'channel-profiles' || root === 'channel-profile') {
    return {
      effect: 'connected-host-state',
      confirmation,
      // agent_operator_method, NOT agent_operator_action: the action tool's
      // allowlist covers only approvals.* and automation.* and cannot invoke
      // ci.*/principals.*/channels.profiles.*, pointing the model there would
      // dead-end in "unknown action".
      preferredModelTool: 'agent_operator_method (methodId "ci.status", "ci.watches.*", "principals.*", "channels.profiles.*")',
      boundary: 'CI status/watches, principal identity mappings, and per-channel profile defaults live on the connected host. Reads run through agent_operator_method without confirmation; writes require confirm + explicitUserRequest there, and mutating slash/CLI subcommands require --yes.',
    };
  }
  if (root === 'schedule' || root === 'remind' || root === 'reminder') {
    return {
      effect: 'connected-host-state',
      confirmation,
      preferredModelTool: 'schedule',
      boundary: 'Connected schedules require an explicit user request and do not create hidden Agent jobs or local schedulers.',
    };
  }
  if (root === 'google' || root === 'gmail') {
    return {
      effect: 'external-network',
      confirmation,
      preferredModelTool: 'google',
      boundary: 'Connects the Google account that backs mail and calendar. /google connect runs the connection flow; /google adopt takes up credentials from files you point it at. Once connected, the google tool is the model route, no MCP server is involved.',
    };
  }
  if (root === 'email') {
    return {
      effect: 'external-network',
      confirmation,
      preferredModelTool: `${agentHarnessModes('run_command')} (use /email set to configure, /email config to view settings)`,
      boundary: 'Email IMAP reads are read-only (EXAMINE); sends require explicit --yes confirmation and route only to the configured account. Use /email set email.<key> <value> to configure email settings; use /email config to view current settings. The generic settings action cannot set email.* keys, /email set is the only supported path.',
    };
  }
  if (root === 'calendar' || root === 'cal') {
    return {
      effect: 'local-state',
      confirmation,
      preferredModelTool: agentHarnessModes('run_command'),
      boundary: 'Calendar commands manage local ICS events only; import/export and mutations require explicit --yes confirmation. Calendar configuration is set via /calendar subcommands, not the generic settings action.',
    };
  }
  if (root === 'channels' || root === 'channel' || root === 'notify') {
    return {
      effect: 'external-network',
      confirmation,
      preferredModelTool: root === 'notify' ? 'agent_notify' : 'agent_channel_send',
      boundary: 'External delivery requires an explicit target and direct user authorization.',
    };
  }
  if (root === 'media') {
    return {
      effect: 'external-network',
      confirmation,
      preferredModelTool: 'agent_media_generate',
      boundary: 'Media generation uses configured Agent media providers and writes normal artifacts only.',
    };
  }
  if (root === 'image') {
    return {
      effect: 'external-network',
      confirmation,
      preferredModelTool: agentHarnessModes('open_ui_surface'),
      boundary: 'Image attachment reads a local image and submits a model turn with image content. Use only for explicit user-supplied files.',
    };
  }
  if (root === 'tts') {
    return {
      effect: 'external-network',
      confirmation,
      preferredModelTool: `${settingsActions('get', 'set')} or ${agentHarnessModes('open_ui_surface')}`,
      boundary: 'Live TTS submits a normal prompt and may call model and speech providers; stopping playback is local runtime control.',
    };
  }
  if (root === 'workplan' || root === 'plan' || root === 'task' || root === 'tasks') {
    return {
      effect: 'local-state',
      confirmation,
      preferredModelTool: 'agent_work_plan',
      boundary: 'Work planning stays in the current Agent/project planning surfaces unless the command explicitly calls connected-host operator routes.',
    };
  }
  if (root === 'delegate') {
    return {
      effect: 'delegated-work',
      confirmation,
      preferredModelTool: agentHarnessModes('workspace_actions', 'workspace_action', 'run_workspace_action'),
      boundary: 'Delegation is explicit user-directed work only; no hidden background review or separate Agent job should be created implicitly.',
    };
  }
  if (
    root === 'session'
    || root === 'conversation'
    || root === 'clear'
    || root === 'reset'
    || root === 'compact'
    || root === 'quit'
    || root === 'exit'
    || root === 'save'
    || root === 'load'
    || root === 'sessions'
    || root === 'title'
    || root === 'undo'
    || root === 'redo'
    || root === 'retry'
  ) {
    return {
      effect: 'session-lifecycle',
      confirmation,
      preferredModelTool: agentHarnessModes('commands', 'command', 'run_command'),
      boundary: 'Session and conversation commands operate on the visible harness session lifecycle.',
    };
  }
  if (root === 'export') {
    return {
      effect: 'local-state',
      confirmation,
      preferredModelTool: `${agentHarnessModes('workspace_actions', 'workspace_action', 'run_workspace_action')} or ${agentHarnessModes('run_command')}`,
      boundary: 'Conversation export writes a local workspace file and requires an explicit output intent.',
    };
  }
  if (root === 'activity') {
    return {
      effect: 'ui-navigation',
      confirmation,
      preferredModelTool: agentHarnessModes('run_command'),
      boundary: 'Opens the Activity view (running work, what needs you, what is coming up, recent activity); it only changes what is on screen.',
    };
  }
  if (root === 'notifications') {
    return {
      effect: 'ui-navigation',
      confirmation,
      preferredModelTool: agentHarnessModes('run_command'),
      boundary: 'Opens the notification history (every system notice in full, newest first); it only changes what is on screen.',
    };
  }
  if (root === 'bookmarks' || root === 'expand' || root === 'collapse' || root === 'next-error' || root === 'prev-error') {
    return {
      effect: 'ui-navigation',
      confirmation,
      preferredModelTool: root === 'bookmarks' ? `${agentHarnessModes('open_ui_surface')} or ${agentHarnessModes('run_command')}` : agentHarnessModes('run_command'),
      boundary: 'Conversation display navigation mutates only the visible transcript view or scroll position.',
    };
  }
  if (root === 'paste') {
    return {
      effect: 'local-state',
      confirmation,
      preferredModelTool: agentHarnessModes('run_keybinding'),
      boundary: 'Paste reads the local clipboard and mutates the visible prompt or image attachment state.',
    };
  }
  if (root === 'profile' || root === 'agent-profile') {
    return {
      effect: 'mixed',
      confirmation,
      preferredModelTool: agentHarnessModes('workspace_actions', 'workspace_action', 'run_workspace_action'),
      boundary: 'Agent profile commands manage isolated Agent runtime profiles and starter templates. Mutations require explicit confirmation.',
    };
  }
  if (root === 'qrcode') {
    return {
      effect: 'read-only',
      confirmation,
      preferredModelTool: agentHarnessModes('run_command'),
      boundary: 'Pairing details are displayed for explicit operator use; the Agent does not manage connected-host listener lifecycle.',
    };
  }
  return {
    effect: 'unknown',
    confirmation,
    boundary: 'Inspect the command description, usage, and workspace action metadata before invoking through run_command.',
  };
}

export function settingsPolicySummary(): Record<string, unknown> {
  return {
    discovery: 'Use settings action:"list" for the setting catalog and action:"get" with key, target, or query for one setting. Hidden/scriptable settings require includeHidden:true unless the exact key is supplied.',
    mutation: 'Use settings action:"set" or action:"reset" with key, target, or query plus confirm:true and explicitUserRequest; ambiguous setting lookups are refused.',
    secretHandling: 'Raw secret values are persisted through the secret manager; config receives only a secret reference and tool output is redacted.',
    writablePolicy: 'Each setting descriptor includes writable and visibleInWorkspace. No setting is read-only to the model any more; danger.httpListener is visible and settable, and is one of the keys that needs the user to ask for it first.',
    // Still declared, and still true: this key needs the user to ask for it
    // first. What changed is the mechanism, it is protected by the narrow
    // confirmation gate in agent-settings-write-policy.ts, which names the key
    // and states the hazard, rather than by the deleted blanket read-only lock.
    protectedRawDangerKeys: ['danger.httpListener'],
  };
}
