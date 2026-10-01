import type { CommandExecutionPolicy } from './agent-harness-metadata.ts';

function agentHarnessModes(...modes: readonly string[]): string {
  return `agent_harness ${modes.map((mode) => `mode:"${mode}"`).join(', ')}`;
}

function settingsActions(...actions: readonly string[]): string {
  return `settings ${actions.map((action) => `action:"${action}"`).join('|')}`;
}

function hostActions(...actions: readonly string[]): string {
  return `host ${actions.map((action) => `action:"${action}"`).join('|')}`;
}

export function describeCliCommandPolicy(commandName: string): CommandExecutionPolicy {
  const root = commandName.trim().toLowerCase();
  const confirmation = 'agent_harness CLI command modes are discovery-only. Use first-class model tools, workspace actions, slash-command mirrors, or an explicit external shell request to execute equivalent CLI workflows.';
  if ([
    'app',
    'bridge',
    'control-plane',
    'controlplane',
    'cp',
    'daemon',
    'http-listener',
    'launch',
    'listener',
    'remote',
    'serve',
    'server',
    'service',
    'services',
    'start',
    'surface',
    'surfaces',
    'web',
    'webhook',
  ].includes(root)) {
    return {
      effect: 'unknown',
      confirmation,
      boundary: 'Blocked package CLI token. Agent can launch its own TUI and use public connected-host routes, but it does not manage connected-host lifecycle, listeners, servers, route relays, remotes, web surfaces, or webhook listeners.',
    };
  }
  if (root === 'tui' || root === 'onboarding' || root === 'help' || root === 'version' || root === 'completion') {
    return {
      effect: root === 'tui' || root === 'onboarding' ? 'ui-navigation' : 'read-only',
      confirmation,
      preferredModelTool: root === 'onboarding' || root === 'tui'
        ? agentHarnessModes('workspace', 'workspace_actions', 'workspace_action', 'run_workspace_action')
        : agentHarnessModes('cli_commands', 'cli_command'),
      boundary: 'Top-level CLI launch, setup, help, version, and completion commands are package entrypoint surfaces; use in-process workspace and slash-command routes from the model when operating inside this agent\'s own interactive session.',
    };
  }
  if (root === 'run') {
    return {
      effect: 'mixed',
      confirmation,
      preferredModelTool: 'current Agent conversation response; do not invoke hidden nested CLI run',
      boundary: 'The CLI run command starts a non-interactive Agent turn from a process entrypoint. Do not create hidden nested turns from agent_harness; answer the user directly in the current conversation.',
    };
  }
  if (root === 'status' || root === 'doctor' || root === 'auth' || root === 'compat' || root === 'models' || root === 'providers' || root === 'tasks') {
    return {
      effect: 'read-only',
      confirmation,
      preferredModelTool: root === 'tasks' ? 'agent_operator_briefing' : `${hostActions('status', 'services', 'service', 'capabilities')} or ${settingsActions('list', 'get')} or ${agentHarnessModes('tools')}`,
      boundary: 'Diagnostics and posture commands are readable from Agent-owned settings, provider, model, and connected-host capability surfaces without taking connected-host lifecycle ownership.',
    };
  }
  if (root === 'profiles' || root === 'personas' || root === 'skills' || root === 'memory' || root === 'routines' || root === 'sessions' || root === 'bundle' || root === 'import' || root === 'workspaces' || root === 'fleet') {
    return {
      effect: 'local-state',
      confirmation,
      preferredModelTool: root === 'profiles' || root === 'workspaces' || root === 'fleet' ? agentHarnessModes('workspace_actions', 'workspace_action', 'run_workspace_action') : 'agent_local_registry',
      boundary: root === 'workspaces'
        ? 'The registered-workspace list that gates automatic checkpoints (owner ruling, 2026-07-10) is Agent-local, user-scoped state. There is no dedicated model tool yet; registration/unregistration is a mutating action and requires explicit user intent (the CLI itself requires --yes).'
        : root === 'fleet'
          ? 'Best-of-N held-merge attempt groups (SDK 1.6.1) are this Agent\'s own orchestration engine state, not a connected-host call, fleet.attempts.* is ws-only with no HTTP binding, so agent_operator_method cannot reach it either. There is no dedicated model tool yet; picking a winner is a mutating, worktree-cleaning action and requires explicit user intent (the CLI itself requires --yes).'
          : 'Local library/profile/session/bundle/import CLI commands operate on Agent-local data. Mutations require explicit user intent and should use first-class Agent-local tools where available.',
    };
  }
  if (root === 'owner-profile') {
    return {
      effect: 'connected-host-state',
      confirmation,
      // The `profile` tool is the model's route, not this CLI. It calls the same
      // nine control-plane verbs the CLI does, and it carries the parts a shell
      // command cannot: the authority naming where a fact came from, his
      // verbatim words, and the one-line disclosure that goes back in the reply.
      preferredModelTool: 'profile',
      boundary: 'The owner profile is one Markdown file at daemon scope that only the daemon writes. Reads run without confirmation; every write carries an authority naming where the fact came from and is refused unless it came from him directly, and mutating CLI subcommands require --yes. The CLI is his own maintenance path for the file, during a conversation the model records facts through the `profile` tool rather than shelling out.',
    };
  }
  if (root === 'ci' || root === 'principals' || root === 'channel-profiles') {
    return {
      effect: 'connected-host-state',
      confirmation,
      // agent_operator_method, NOT agent_operator_action: the action tool's
      // allowlist covers only approvals.* and automation.* and cannot invoke
      // ci.*/principals.*/channels.profiles.*, pointing the model there would
      // dead-end in "unknown action". The generic operator-method tool routes
      // these directly (read-only methods run without confirmation; writes
      // require confirm + explicitUserRequest).
      preferredModelTool: 'agent_operator_method (methodId "ci.status", "ci.watches.*", "principals.*", "channels.profiles.*")',
      boundary: 'CI status/watches, principal identity mappings, and per-channel profile defaults live on the connected host. Reads run through agent_operator_method without confirmation; writes require confirm + explicitUserRequest there, and mutating CLI subcommands require --yes.',
    };
  }
  if (root === 'knowledge' || root === 'ask' || root === 'search') {
    return {
      effect: 'mixed',
      confirmation,
      preferredModelTool: root === 'knowledge' ? 'agent_knowledge or agent_knowledge_ingest' : 'agent_knowledge',
      boundary: 'Agent Knowledge CLI commands must stay on isolated Agent Knowledge routes and never fall back to default or non-Agent knowledge spaces.',
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
  if (root === 'browser') {
    return {
      // Provisioning downloads a driver and a browser, and navigation reaches
      // the network, so this is never merely read-only.
      effect: 'external-network',
      confirmation,
      preferredModelTool: 'browser',
      boundary: 'The CLI is a scriptable mirror of the browser tool, for diagnosing an install from a shell, in a conversation the model calls the browser tool directly rather than shelling out. It builds the same tool the model calls, so the two can never disagree. Sessions it opens are closed when the command exits, and only browsers this agent launched are ever closed.',
    };
  }
  if (root === 'relay') {
    return {
      effect: 'read-only',
      confirmation,
      preferredModelTool: `${settingsActions('list', 'get')} (category "relay") or ${agentHarnessModes('tools')}`,
      boundary: 'relay status reports the connected host\'s imported relay.* configuration and the relay-connect feature flag only, it is not a live check (Agent hosts no daemon and the SDK has no remote relay-status route). relay pair always honestly refuses: minting a pairing payload needs the relay identity private key, which only the daemon actually holding the relay identity has.',
    };
  }
  if (root === 'subscription' || root === 'secrets' || root === 'pair') {
    return {
      effect: root === 'pair' ? 'external-network' : 'mixed',
      confirmation,
      preferredModelTool: root === 'pair'
        ? agentHarnessModes('workspace_actions', 'workspace_action', 'run_workspace_action')
        : `${settingsActions('list', 'get', 'set', 'reset')} or ${agentHarnessModes('workspace_actions')}`,
      boundary: 'Provider subscription, secret, and pairing flows can expose credentials or external account state. Use only explicit user-directed flows and prefer secret refs over raw values.',
    };
  }
  return {
    effect: 'unknown',
    confirmation,
    boundary: 'Inspect the CLI help, parser result, and preferred model routes before using an equivalent command path.',
  };
}
