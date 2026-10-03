import { previewHarnessText } from './agent-harness-text.ts';
export function hasAny(lower: string, tokens: readonly string[]): boolean {
  return tokens.some((token) => lower.includes(token));
}

export function hasAll(lower: string, tokens: readonly string[]): boolean {
  return tokens.every((token) => lower.includes(token));
}

export function quote(value: string, limit = 96): string {
  return JSON.stringify(previewHarnessText(value, limit));
}

export const MODE_SEARCH_STOPWORDS = new Set(['a', 'an', 'and', 'for', 'from', 'in', 'my', 'of', 'on', 'or', 'please', 'the', 'this', 'to', 'with']);

export function simplifiedModeQuery(input: string): string {
  return input
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .filter((token) => token.length > 0 && !MODE_SEARCH_STOPWORDS.has(token))
    .map((token) => (token.endsWith('s') && token.length > 4 ? token.slice(0, -1) : token))
    .join(' ');
}

export function scheduleLike(lower: string): boolean {
  return hasAny(lower, [
    'schedule',
    'scheduled',
    'recurring',
    'repeat',
    'remind',
    'reminder',
    'cron',
    'every ',
    'daily',
    'weekly',
    'monthly',
    'tomorrow',
    'next week',
    'follow up',
    'follow-up',
  ]);
}

export function autonomousLike(lower: string): boolean {
  return scheduleLike(lower) || hasAny(lower, [
    'autonomous',
    'ongoing',
    'long-running',
    'background',
    'monitor',
    'watcher',
    'webhook',
    'trigger',
    'when a ',
    'when an ',
    'wake up',
    'wake-up',
  ]);
}

export function directScheduleLike(lower: string): boolean {
  if (hasAny(lower, ['remind me', 'reminder', 'create reminder', 'schedule reminder'])) return true;
  if (hasAny(lower, ['schedule ', 'scheduled task', 'scheduled work', 'cron'])) return true;
  return hasAny(lower, ['pause schedule', 'resume schedule', 'run schedule', 'edit schedule', 'delete schedule', 'cancel schedule', 'enable schedule', 'disable schedule']);
}

export function hostDiagnosticsLike(lower: string): boolean {
  if (hasAny(lower, ['daemon health', 'daemon status', 'daemon doctor', 'host health', 'host status', 'host doctor', 'service health', 'service status', 'health check'])) return true;
  const runtimeTarget = hasAny(lower, ['daemon', 'host', 'connected host', 'service', 'control plane', 'operator api', 'goodvibes runtime']);
  const diagnosticIntent = hasAny(lower, ['health', 'status', 'doctor', 'diagnose', 'diagnostic', 'readiness', 'compat', 'compatibility']);
  return runtimeTarget && diagnosticIntent;
}

export function mediaGenerationLike(lower: string): boolean {
  const generationIntent = hasAny(lower, ['generate', 'create', 'make', 'render', 'draw', 'produce']);
  if (!generationIntent) return false;
  return hasAny(lower, ['image', 'video', 'media', 'picture', 'thumbnail', 'logo', 'illustration', 'graphic', 'artwork']);
}

export function browserControlLike(lower: string): boolean {
  return hasAny(lower, [
    'browser control',
    'desktop control',
    'computer use',
    'take screenshot',
    'take a screenshot',
    'screenshot',
    'screen recording',
    'record screen',
    'record the screen',
    'observe screen',
    'observe the screen',
    'capture screen',
    'capture the screen',
    'use the browser',
    'use browser',
    'navigate browser',
    'click in browser',
    'click the page',
    'fill form',
    'fill out form',
    'logged-in page',
    'logged in page',
    'move mouse',
    'type into',
    'control desktop',
    'control the desktop',
  ]);
}

export const EXTERNAL_MEMORY_PROVIDER_IDS = [
  'honcho',
  'openviking',
  'mem0',
  'hindsight',
  'holographic',
  'retaindb',
  'byterover',
  'supermemory',
] as const;

export function externalMemoryProviderId(lower: string): string | null {
  return EXTERNAL_MEMORY_PROVIDER_IDS.find((provider) => lower.includes(provider)) ?? null;
}

export function externalMemoryProviderLike(lower: string): boolean {
  if (externalMemoryProviderId(lower)) return true;
  return hasAny(lower, [
    'external memory',
    'memory provider',
    'memory backend',
    'cross-session memory',
    'memory sync',
    'memory import',
    'memory export',
  ]);
}

export function processLifecycleLike(lower: string): boolean {
  if (lower.includes('background') && hasAny(lower, [
    'build',
    'bun ',
    'command',
    'dev server',
    'execute',
    'launch',
    'npm ',
    'pnpm ',
    'process',
    'pytest',
    'server',
    'start ',
    'terminal',
    'test',
    'yarn ',
  ])) return true;
  return hasAny(lower, [
    'background process',
    'background command',
    'background:true',
    'run in background',
    'run it in the background',
    'start in background',
    'terminal background',
    'terminal command',
    'process action',
    'process list',
    'process poll',
    'process log',
    'process wait',
    'process kill',
    'process write',
    'poll process',
    'log process',
    'wait process',
    'kill process',
    'stop process',
    'stdin',
    'pty',
  ]);
}

export function interactiveProcessCapabilityLike(lower: string): boolean {
  if (hasAny(lower, [
    'pty',
    'interactive cli',
    'interactive command',
    'interactive shell',
    'interactive terminal',
    'terminal input',
    'process input',
    'process write',
    'stdin',
    'send input',
    'write to process',
    'password prompt',
    'sudo',
    'sudo_password',
    'privilege escalation',
    'claude code',
    'codex cli',
  ])) return true;
  return hasAll(lower, ['terminal', 'input']);
}

export function fileRecoveryLike(lower: string): boolean {
  const recoveryWord = hasAny(lower, ['undo', 'redo', 'recover', 'recovery', 'restore', 'revert', 'roll back', 'rollback']);
  if (!recoveryWord) return false;
  return hasAny(lower, ['file', 'edit', 'write', 'patch', 'diff', 'change', 'snapshot', 'workspace']);
}

export function researchRunnerLike(lower: string): boolean {
  if (hasAny(lower, [
    'browser-backed research',
    'browser backed research',
    'browser-backed runner',
    'browser backed runner',
    'browser research runner',
    'research runner',
    'deep research runner',
    'live research runner',
  ])) return true;
  return lower.includes('runner readiness') && hasAny(lower, ['research', 'browser']);
}

export function visualResearchReportLike(lower: string): boolean {
  return hasAny(lower, [
    'visual report',
    'visual-report',
    'visual research report',
    'research report packet',
    'visual report packet',
    'report packet',
    'browser report rendering',
    'browser/pwa report',
    'render visual report',
    'render the visual report',
    'render research report',
  ]);
}

export function voiceWorkflowLike(lower: string): boolean {
  return hasAny(lower, [
    'voice workflow',
    'voice memo',
    'voice transcription',
    'transcribe voice',
    'transcribe audio',
    'push-to-talk',
    'push to talk',
    'wake word',
    'wake-word',
    'spoken response',
    'spoken responses',
    'talk to the assistant',
    'talk to agent',
  ]);
}

export function ttsProviderLike(lower: string): boolean {
  return hasAny(lower, [
    'tts provider',
    'tts voice',
    'tts picker',
    'text to speech',
    'text-to-speech',
    'speech synthesis',
    'spoken provider',
    'voice provider',
  ]);
}

export function browserCockpitLike(lower: string): boolean {
  return hasAny(lower, [
    'browser cockpit',
    'connected browser',
    'browser dashboard',
    'web dashboard',
    'pwa',
    'open browser dashboard',
    'open browser cockpit',
    'mobile pwa',
  ]);
}

export type PersonalOpsLaneId = 'inbox' | 'calendar' | 'notes' | 'tasks' | 'reminders' | 'routines' | 'delivery';

export function personalOpsLike(lower: string): boolean {
  return hasAny(lower, [
    'personal ops',
    'daily brief',
    'daily briefing',
    'morning brief',
    'morning briefing',
    'inbox',
    'email',
    'gmail',
    'imap',
    'smtp',
    'calendar',
    'caldav',
    'agenda',
    'rsvp',
    'draft reply',
    'reply to',
    'tasks',
    'todo',
    'to-do',
    'note',
    'routine',
    'review queue',
    'saved review',
  ]);
}

export function personalOpsLaneFromText(lower: string): PersonalOpsLaneId | null {
  if (hasAny(lower, ['inbox', 'email', 'mail', 'gmail', 'imap', 'smtp', 'message', 'thread', 'draft reply', 'reply to'])) return 'inbox';
  if (hasAny(lower, ['calendar', 'caldav', 'agenda', 'meeting', 'event', 'availability', 'freebusy', 'free busy', 'rsvp'])) return 'calendar';
  if (hasAny(lower, ['note', 'scratchpad', 'jot down'])) return 'notes';
  if (hasAny(lower, ['task', 'tasks', 'todo', 'to-do', 'work item', 'work plan'])) return 'tasks';
  if (hasAny(lower, ['reminder', 'reminders', 'follow up', 'follow-up', 'ping me'])) return 'reminders';
  if (hasAny(lower, ['routine', 'checklist', 'repeatable'])) return 'routines';
  if (hasAny(lower, ['delivery', 'deliver', 'send summary', 'send briefing'])) return 'delivery';
  return null;
}

export function personalOpsBriefingLike(lower: string): boolean {
  if (hasAny(lower, ['daily brief', 'daily briefing', 'morning brief', 'morning briefing', 'brief me', 'brief my', 'briefing'])) return true;
  return hasAny(lower, ['what is on my calendar', "what's on my calendar", 'today agenda', "today's agenda", 'agenda today']);
}

export function personalOpsQueueLike(lower: string): boolean {
  return hasAny(lower, [
    'review queue',
    'saved review',
    'saved inbox',
    'saved calendar',
    'saved thread',
    'saved event',
    'queued inbox',
    'queued calendar',
  ]);
}

export function personalOpsConnectorSetupLike(lower: string): boolean {
  const connector = hasAny(lower, ['gmail', 'imap', 'smtp', 'email connector', 'mail connector', 'calendar connector', 'caldav', 'mcp connector']);
  const setup = hasAny(lower, ['set up', 'setup', 'connect', 'configure', 'enable', 'repair', 'provider']);
  return connector && setup;
}

export function personalOpsFreshReadLike(lower: string): boolean {
  return hasAny(lower, [
    'read live',
    'refresh',
    'fresh read',
    'fetch',
    'sync',
    'pull latest',
    'latest email',
    'new email',
    'unread',
    'upcoming event',
    'upcoming meeting',
    'calendar today',
    'today calendar',
  ]);
}

export function personalOpsMutationLike(lower: string): boolean {
  return hasAny(lower, ['send', 'reply', 'archive', 'label', 'edit', 'rsvp', 'delete', 'move', 'create event', 'reschedule']);
}

export function externalChannelLike(lower: string): boolean {
  return hasAny(lower, ['slack', 'discord', 'telegram', 'whatsapp', 'signal', 'matrix', 'teams', 'ntfy', 'webhook', 'notification', 'notify', 'send message', 'channel', 'delivery receipt']);
}

export function channelTargetFromText(lower: string): string | null {
  return ['slack', 'discord', 'telegram', 'whatsapp', 'signal', 'matrix', 'teams', 'ntfy', 'webhook'].find((target) => lower.includes(target)) ?? null;
}

export function channelSetupLike(lower: string): boolean {
  return hasAny(lower, ['set up', 'setup', 'connect', 'configure', 'enable', 'repair']) && externalChannelLike(lower);
}

export function channelTriageLike(lower: string): boolean {
  return hasAny(lower, ['triage', 'blocker', 'blockers', 'retry', 'retries', 'failed', 'failure', 'error', 'pending message', 'pending delivery', 'doctor']) && externalChannelLike(lower);
}

export function channelDeliveriesLike(lower: string): boolean {
  return hasAny(lower, ['delivery receipt', 'delivery receipts', 'delivery history', 'send history', 'sent messages', 'send outcomes', 'recent deliveries']);
}

export function channelSendLike(lower: string): boolean {
  return hasAny(lower, ['send', 'notify', 'deliver', 'test send', 'test notification', 'ping']);
}

export const MODEL_PROVIDER_IDS = [
  'openrouter',
  'openai',
  'anthropic',
  'claude',
  'ollama',
  'llama.cpp',
  'llamacpp',
  'vllm',
  'lm studio',
] as const;

export function modelProviderId(lower: string): string | null {
  const provider = MODEL_PROVIDER_IDS.find((candidate) => lower.includes(candidate));
  if (!provider) return null;
  if (provider === 'llama.cpp' || provider === 'llamacpp') return 'llama.cpp';
  if (provider === 'lm studio') return 'lm-studio';
  return provider;
}

export function localModelLike(lower: string): boolean {
  return hasAny(lower, [
    'local model',
    'local server',
    'local endpoint',
    'local ai',
    'ollama',
    'llama.cpp',
    'llamacpp',
    'vllm',
    'lm studio',
    'cookbook',
    'model recipe',
    'hardware fit',
    'serve model',
    'download model',
  ]);
}

export function localModelSmokeLike(lower: string): boolean {
  return hasAny(lower, [
    'local model smoke',
    'model smoke',
    'check local model',
    'check local servers',
    'local server health',
    'server health',
    'model-list smoke',
    'test ollama',
    'smoke ollama',
  ]);
}

export function providerAccountLike(lower: string): boolean {
  return hasAny(lower, [
    'provider account',
    'provider auth',
    'subscription',
    'api key',
    'apikey',
    'openrouter',
    'openai',
    'anthropic',
    'claude',
    'login',
    'billing',
  ]);
}

export function modelRouteReadinessLike(lower: string): boolean {
  return hasAny(lower, [
    'model route',
    'route readiness',
    'best model',
    'choose model',
    'pick model',
    'compare route',
    'context window',
    'long context',
    'tool support',
    'vision model',
    'latency',
    'model cost',
    'privacy',
  ]);
}

export function securityPermissionLike(lower: string): boolean {
  return hasAny(lower, [
    'security',
    'permission',
    'permissions',
    'policy',
    'policies',
    'approval',
    'approvals',
    'approve',
    'approved',
    'deny',
    'denied',
    'blocked',
    'allowed',
    'confirmation',
    'requires confirmation',
    'guardrail',
    'safety',
    'risky action',
    'unsafe action',
  ]);
}

export function securityStatusLike(lower: string): boolean {
  if (hasAny(lower, [
    'security status',
    'security posture',
    'permission status',
    'permissions status',
    'current permissions',
    'active permissions',
    'permission mode',
    'approval mode',
    'approval settings',
    'tool permissions',
    'security dashboard',
    'safety status',
    'current policy',
    'policy status',
    'policy settings',
  ])) return true;
  return hasAny(lower, ['show', 'list', 'what are', 'what is', 'which']) && hasAny(lower, ['permissions', 'approvals', 'policy', 'allowed tools']);
}

export function securityFindingLike(lower: string): boolean {
  const finding = hasAny(lower, [
    'finding',
    'findings',
    'incident',
    'security issue',
    'vulnerability',
    'leaked secret',
    'secret leak',
    'exposed token',
    'exposed secret',
    'mcp trust',
    'quarantine',
  ]);
  if (!finding) return false;
  return hasAny(lower, ['security', 'policy', 'permission', 'mcp', 'secret', 'token', 'incident', 'vulnerability', 'finding']);
}

export function securityPolicyExplainLike(lower: string): boolean {
  if (hasAny(lower, [
    'why denied',
    'why was denied',
    'why blocked',
    'why was blocked',
    'why allowed',
    'why did you block',
    'why would',
    'why does',
    'explain policy',
    'explain permission',
    'explain approval',
    'explain confirmation',
    'need confirmation',
    'needs confirmation',
    'requires confirmation',
    'would be blocked',
    'will be blocked',
    'risky action',
    'unsafe action',
    'can you run',
    'can you use',
    'am i allowed',
  ])) return true;
  return hasAny(lower, ['blocked', 'denied', 'allowed', 'approval', 'confirmation']) && hasAny(lower, ['tool', 'action', 'route', 'command', 'call', 'execute', 'run', 'write', 'send', 'setting']);
}

export function securityPolicyToolTarget(lower: string): string | null {
  if (lower.includes('agent_harness')) return 'agent_harness';
  if (lower.includes('settings action') || lower.includes('setting')) return 'settings';
  if (lower.includes('terminal')) return 'terminal';
  if (lower.includes('process')) return 'process';
  if (lower.includes('exec')) return 'exec';
  if (lower.includes('channel')) return 'channels';
  if (lower.includes('schedule')) return 'schedule';
  if (lower.includes('personal_ops') || lower.includes('personal ops')) return 'personal_ops';
  if (lower.includes('model')) return 'models';
  if (lower.includes('memory')) return 'memory';
  if (lower.includes('computer') || lower.includes('browser') || lower.includes('screenshot')) return 'computer';
  if (lower.includes('device') || lower.includes('voice') || lower.includes('tts')) return 'device';
  if (lower.includes('workspace')) return 'workspace';
  if (lower.includes('host') || lower.includes('daemon')) return 'host';
  if (lower.includes('command')) return 'terminal';
  return null;
}

export function supportBundleLike(lower: string): boolean {
  if (hasAny(lower, ['support bundle', 'support packet', 'diagnostic bundle', 'diagnostics bundle', 'forensic bundle', 'forensics bundle'])) return true;
  return lower.includes('bundle') && hasAny(lower, ['support', 'diagnostic', 'diagnostics', 'forensic', 'forensics', 'auth', 'trust', 'subscription', 'security']);
}

export function supportBundleEffectLike(lower: string): boolean {
  return hasAny(lower, ['export', 'import', 'create', 'generate', 'save', 'write', 'share', 'attach', 'send']);
}

export function sessionWorkspaceLike(lower: string): boolean {
  if (hasAny(lower, [
    'saved session',
    'saved sessions',
    'session search',
    'search sessions',
    'session export',
    'export session',
    'session resume',
    'resume session',
    'session load',
    'load session',
    'session save',
    'save session',
    'session delete',
    'delete session',
    'session rename',
    'rename session',
    'session fork',
    'fork session',
    'session graph',
    'session bookmark',
    'bookmarked session',
    'bookmarks',
    'conversation restore',
    'restore conversation',
    'previous conversation',
    'past conversation',
    'transcript export',
    'export transcript',
    'return context',
    'session continuity',
  ])) return true;
  return lower.includes('session') && hasAny(lower, ['browse', 'find', 'search', 'show', 'inspect', 'resume', 'load', 'save', 'export', 'delete', 'rename', 'fork', 'bookmark']);
}

export function sessionMutationLike(lower: string): boolean {
  if (hasAny(lower, ['resume', 'load', 'rename', 'fork', 'delete', 'remove', 'restore', 'export', 'unbookmark'])) return true;
  return hasAny(lower, ['save session', 'session save', 'bookmark session', 'session bookmark']);
}

export function releaseAuditLike(lower: string): boolean {
  return hasAny(lower, [
    'release evidence',
    'release artifact',
    'release artifacts',
    'release readiness',
    'release quality',
    'readiness inventory',
    'release inventory',
    'release gate',
    'release gates',
    'verification ledger',
    'operator audit',
    'audit evidence',
    'audit artifact',
    'audit artifacts',
    'package evidence',
  ]);
}

export function releaseEvidenceLike(lower: string): boolean {
  return hasAny(lower, ['release evidence', 'release artifact', 'release artifacts', 'audit evidence', 'audit artifact', 'audit artifacts', 'verification ledger', 'package evidence']);
}
