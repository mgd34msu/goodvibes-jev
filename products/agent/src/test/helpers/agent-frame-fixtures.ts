/**
 * agent-frame-fixtures.ts, deterministic whole-screen frames of every Agent
 * surface for the golden-frame test (and for looking at them).
 *
 * Each fixture returns a full width x height screen (Line[]): the base screen
 * (header, transcript, composer, status line), the home splash, and every
 * modal, popup and bar drawn over the screen exactly the way the compositor
 * stamps them (surface-frame.ts). Inputs are frozen: pinned version, fixed
 * clocks (`withFixedClock` pins Date.now; TZ is UTC), no live services.
 */

import { join } from 'node:path';
import { createEmptyLine, type Line } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ModelDefinition } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { SessionInfo, SessionManager } from '@goodvibes-jev/engine/sdk/platform/sessions';
import type { BookmarkEntry, BookmarkManager } from '@goodvibes-jev/engine/sdk/platform/bookmarks';
import type { ProfileManager } from '@goodvibes-jev/engine/sdk/platform/profiles';
import type { PermissionRequest } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { ConfigManager, ServiceRegistry, SubscriptionManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { McpRegistry } from '@goodvibes-jev/engine/sdk/platform/mcp';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import { UIFactory } from '../../renderer/ui-factory.ts';
import { withHeaderGap } from '../../renderer/header-line.ts';
import { buildShellFooter, type ShellFooterBuildOptions } from '../../renderer/shell-surface.ts';
import { renderMarkdown } from '../../renderer/markdown.ts';
import { renderCodeBlock } from '../../renderer/code-block.ts';
import { renderDiffView } from '../../renderer/diff-view.ts';
import { renderConversationEventLine } from '../../renderer/conversation-surface.ts';
import { centerViewportContent } from '../../renderer/conversation-layout.ts';
import { addConversationSplashScreen } from '../../core/conversation-rendering.ts';
import type { ConversationRenderContext } from '../../core/conversation-render-context.ts';
import type { ConversationManager } from '../../core/conversation.ts';
import { activeTokens } from '../../renderer/theme.ts';
import type { SurfaceLayer } from '../../renderer/surface-kit.ts';
import { frameFromLayer, frameFromLayers } from './surface-frame.ts';
import { SelectionModal } from '../../input/selection-modal.ts';
import { renderSelectionModalOverlay } from '../../renderer/selection-modal-overlay.ts';
import { SessionPickerModal } from '../../input/session-picker-modal.ts';
import { renderSessionPickerModal } from '../../renderer/session-picker-modal.ts';
import { ProfilePickerModal } from '../../input/profile-picker-modal.ts';
import { renderProfilePickerModal } from '../../renderer/profile-picker-modal.ts';
import { BookmarkModal } from '../../input/bookmark-modal.ts';
import { renderBookmarkModal } from '../../renderer/bookmark-modal.ts';
import { ContextInspectorModal, renderContextInspector } from '../../renderer/context-inspector.ts';
import { KeybindingsManager } from '../../input/keybindings.ts';
import { CommandRegistry } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';
import { renderHelpOverlay, renderShortcutsOverlay } from '../../renderer/help-overlay.ts';
import { OverlayFilter } from '../../input/overlay-filter.ts';
import { ProcessModal, renderProcessModal } from '../../renderer/process-modal.ts';
import { LiveTailModal, renderLiveTailModal } from '../../renderer/live-tail-modal.ts';
import { SettingsModal } from '../../input/settings-modal.ts';
import { renderSettingsModal } from '../../renderer/settings-modal.ts';
import { SecretsManager } from '../../config/secrets.ts';
import { ModelPickerModal } from '../../input/model-picker.ts';
import { renderModelWorkspace } from '../../renderer/model-workspace.ts';
import { McpWorkspace } from '../../input/mcp-workspace.ts';
import { renderMcpWorkspace } from '../../renderer/mcp-workspace.ts';
import { AgentWorkspace } from '../../input/agent-workspace.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { renderAgentWorkspace } from '../../renderer/agent-workspace.ts';
import { PermissionPromptUI } from '../../permissions/prompt.ts';
import { BlockActionsMenu } from '../../renderer/block-actions.ts';
import { renderBlockActionsMenu } from '../../renderer/block-actions-overlay.ts';
import { ActivityModal } from '../../input/activity-modal.ts';
import type { ActivityView } from '../../renderer/activity-modal.ts';
import { AutocompleteEngine } from '../../input/autocomplete.ts';
import { renderAutocompleteOverlay } from '../../renderer/autocomplete-overlay.ts';
import { FilePickerModal } from '../../input/file-picker.ts';
import { renderFilePickerOverlay } from '../../renderer/file-picker-overlay.ts';
import { overlayViewportBottom } from '../../renderer/conversation-layout.ts';
import { HistorySearch } from '../../input/input-history.ts';
import { renderHistorySearchOverlay } from '../../renderer/history-search-overlay.ts';
import { SearchManager } from '../../input/search.ts';
import { renderSearchOverlay } from '../../renderer/search-overlay.ts';
import { makeProjectTempDir } from './project-temp.ts';

/** The version the header shows in every frame (never the live build). */
export const FIXTURE_VERSION = '0.0.0-golden';
/** The clock every frame is drawn at: 2026-09-29 15:30 UTC. */
export const FIXTURE_NOW = Date.UTC(2026, 8, 29, 15, 30, 0);

/** Run `fn` with Date.now pinned to FIXTURE_NOW and TZ=UTC. */
export function withFixedClock<T>(fn: () => T): T {
  const realNow = Date.now;
  const realTz = process.env['TZ'];
  process.env['TZ'] = 'UTC';
  Date.now = () => FIXTURE_NOW;
  try {
    return fn();
  } finally {
    Date.now = realNow;
    if (realTz === undefined) delete process.env['TZ'];
    else process.env['TZ'] = realTz;
  }
}

// ---------------------------------------------------------------------------
// The base screen
// ---------------------------------------------------------------------------

export function fixtureFooter(width: number, overrides: Partial<ShellFooterBuildOptions> = {}): Line[] {
  return buildShellFooter({
    width,
    promptText: '',
    promptLineCount: 1,
    promptCursorPos: 0,
    usage: { up: 53_000, down: 1_700 },
    showExitNotice: false,
    lastCopyTime: 0,
    model: 'claude-opus-4',
    workingDir: '/workspace/assistant',
    contextWindow: 1_000_000,
    compactThreshold: 80,
    lastInputTokens: 340_000,
    hitlMode: 'balanced',
    runningAgentCount: 0,
    runningProcessCount: 0,
    indicatorFocused: false,
    composerMode: 'prompt',
    ...overrides,
  }).lines;
}

function screenFrame(width: number, height: number, header: Line[], body: Line[], footer: Line[]): Line[] {
  const room = height - header.length - footer.length;
  const visible = body.slice(Math.max(0, body.length - room));
  while (visible.length < room) visible.unshift(createEmptyLine(width));
  return [...header, ...visible, ...footer];
}

/** The transcript of the base screen: a user message, the quiet assistant marker and a markdown answer. */
export function fixtureTranscript(width: number): Line[] {
  const t = activeTokens();
  const body: Line[] = [createEmptyLine(width)];
  body.push(...UIFactory.createMessageBar(width, 'Find me a flight to Lisbon next Friday under $400, and remind me on Thursday morning to pack the adapter.'));
  body.push(createEmptyLine(width));
  body.push(renderConversationEventLine(width, { marker: '◆', markerFg: t.brand, label: '', labelFg: t.textFaint, detailFg: t.textFaint }, [
    { text: ' claude-opus-4', fg: t.textFaint }, { text: ' · 3 tools', fg: t.textFaint },
  ]));
  body.push(...renderMarkdown([
    '## Two options under $400',
    'Both leave **Friday morning**; the cheaper one has a short layover in `MAD`.',
    '1. TAP direct, 07:40, $389',
    '2. Iberia via Madrid, 06:15, $312',
    '- A reminder is set for Thursday at 08:00: pack the travel adapter.',
    '> Fares change often; this quote wraps so its bar shows on every row it takes up on screen.',
    '```json',
    '{ "reminder": "pack the adapter", "at": "2026-10-01T08:00" }',
    '```',
    '| Option | Price |',
    '|---|---|',
    '| TAP | $389 |',
    '| Iberia | $312 |',
  ].join('\n'), width));
  return body;
}

export function fixtureBaseScreen(width: number, height: number, footerOverrides: Partial<ShellFooterBuildOptions> = {}): Line[] {
  const header = withHeaderGap(UIFactory.createHeader(width, 'claude-opus-4', 'Lisbon trip', FIXTURE_VERSION), width);
  return screenFrame(width, height, header, fixtureTranscript(width), fixtureFooter(width, { dangerMode: true, ...footerOverrides }));
}

/** The splash rows, as the conversation draws them. */
export function fixtureSplash(width: number): Line[] {
  const lines: Line[] = [];
  const context = {
    history: {
      addLine: (line: Line) => { lines.push(line); },
      addLines: (more: Line[]) => { lines.push(...more); },
      getLineCount: () => lines.length,
    },
    splashOptions: { workingDir: '/workspace/assistant', model: 'claude-opus-4', provider: 'anthropic', toolCount: 42, version: FIXTURE_VERSION },
  } as unknown as ConversationRenderContext;
  addConversationSplashScreen(context, width);
  return lines;
}

export function fixtureHomeScreen(width: number, height: number): Line[] {
  const header = withHeaderGap(UIFactory.createHeader(width, 'claude-opus-4', undefined, FIXTURE_VERSION), width);
  const footer = fixtureFooter(width);
  const room = height - header.length - footer.length;
  return [...header, ...centerViewportContent(fixtureSplash(width), room, width), ...footer];
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

function over(layer: SurfaceLayer | null, width: number, height: number, onBase: boolean): Line[] {
  return frameFromLayer(layer, width, height, onBase ? fixtureBaseScreen(width, height) : undefined);
}

export function fixtureSelectionModal(width: number, height: number, onBase = false): Line[] {
  const modal = new SelectionModal();
  modal.open('Choose a reminder channel', [
    { id: 'telegram', label: 'Telegram', detail: 'Delivered to @owner', category: 'Connected' },
    { id: 'email', label: 'Email', detail: 'owner@example.com', category: 'Connected' },
    { id: 'slack', label: 'Slack', detail: 'Not connected yet: open the Agent workspace to connect it', category: 'Available' },
    { id: 'desktop', label: 'Desktop notification', category: 'Available' },
  ]);
  modal.moveDown();
  return over(renderSelectionModalOverlay(modal, width, height), width, height, onBase);
}

export function fixtureSessionPicker(width: number, height: number, onBase = false): Line[] {
  const day = 86_400_000;
  const sessions: SessionInfo[] = [
    { name: 'lisbon-trip', title: 'Lisbon trip', timestamp: FIXTURE_NOW - 3_600_000, messageCount: 18 },
    { name: 'tax-docs', title: 'Gather tax documents', timestamp: FIXTURE_NOW - day, messageCount: 42 },
    { name: 'weekly-review', timestamp: FIXTURE_NOW - 3 * day, messageCount: 7 },
    { name: 'garden-plan', title: 'Plan the vegetable garden', timestamp: FIXTURE_NOW - 40 * day, messageCount: 25 },
  ] as SessionInfo[];
  const modal = new SessionPickerModal({ list: () => sessions } as unknown as SessionManager);
  modal.open();
  modal.moveDown();
  return over(renderSessionPickerModal(modal, width, height, FIXTURE_NOW), width, height, onBase);
}

export function fixtureProfilePicker(width: number, height: number, onBase = false): Line[] {
  const modal = new ProfilePickerModal({
    list: () => [
      { name: 'focus', timestamp: FIXTURE_NOW - 7_200_000 },
      { name: 'travel', timestamp: FIXTURE_NOW - 86_400_000 },
    ],
  } as unknown as ProfileManager);
  modal.open();
  return over(renderProfilePickerModal(modal, width, height), width, height, onBase);
}

export function fixtureBookmarks(width: number, height: number, onBase = false): Line[] {
  const entries: BookmarkEntry[] = [
    { key: 'msg_4', label: 'Flight options under $400', timestamp: FIXTURE_NOW - 600_000 },
    { key: 'msg_9', label: 'Packing list for Lisbon', timestamp: FIXTURE_NOW - 300_000 },
  ] as BookmarkEntry[];
  const modal = new BookmarkModal({ list: () => entries, listSavedFiles: () => [], toggle: () => undefined, loadSavedFile: () => null } as unknown as BookmarkManager);
  modal.open();
  return over(renderBookmarkModal(modal, width, height), width, height, onBase);
}

export function fixtureContextInspector(width: number, height: number, onBase = false): Line[] {
  const conversation = {
    getMessagesForLLM: () => [
      { role: 'user', content: 'Find me a flight to Lisbon next Friday under $400.' },
      { role: 'assistant', content: 'Two options under $400: TAP direct and Iberia via Madrid. '.repeat(40) },
      { role: 'user', content: 'Remind me Thursday morning to pack the adapter.' },
      { role: 'assistant', content: 'A reminder is set for Thursday at 08:00.' },
    ],
  } as unknown as ConversationManager;
  const modal = new ContextInspectorModal();
  modal.open();
  return over(renderContextInspector(conversation, width, height, 200_000, modal), width, height, onBase);
}

function keybindings(): KeybindingsManager {
  return new KeybindingsManager({ configPath: '/nonexistent/goodvibes-golden/keybindings.json' });
}

export function fixtureHelp(width: number, height: number, onBase = false, query = ''): Line[] {
  const registry = new CommandRegistry();
  registerBuiltinCommands(registry);
  const filter = new OverlayFilter();
  filter.query = query;
  return over(renderHelpOverlay(width, height, keybindings(), registry.getVisible(), 0, filter), width, height, onBase);
}

export function fixtureShortcuts(width: number, height: number, onBase = false): Line[] {
  return over(renderShortcutsOverlay(width, height, keybindings(), 0, new OverlayFilter()), width, height, onBase);
}

const PROCESSES = [
  { id: 'p1', cmd: 'rsync -a ~/Photos/2026 /mnt/backup/photos', status: 'running' },
  { id: 'p2', cmd: 'python3 scripts/fetch_fares.py --from OPO --to LIS --date 2026-10-02', status: 'running' },
  { id: 'p3', cmd: 'ffmpeg -i interview.m4a interview.wav', status: 'failed' },
];

export function fixtureProcessModal(width: number, height: number, onBase = false): Line[] {
  return withFixedClock(() => {
    const modal = new ProcessModal({
      processManager: {
        list: () => PROCESSES,
        getStatus: (id: string) => ({ startTime: FIXTURE_NOW - (id === 'p1' ? 185_000 : 42_000) }),
        stop: () => true,
      } as never,
    });
    modal.refresh();
    modal.active = true;
    modal.moveDown();
    return over(renderProcessModal(modal, width, height), width, height, onBase);
  });
}

export function fixtureLiveTail(width: number, height: number, onBase = false): Line[] {
  const modal = new LiveTailModal({
    processManager: {
      stop: () => true,
      getOutput: () => ({
        stdout: Array.from({ length: 30 }, (_, i) => `sending incremental file list ${i + 1}: IMG_${String(4200 + i).padStart(4, '0')}.jpg  3.2MB  100%  41.20MB/s`).join('\n'),
        stderr: '',
      }),
    } as never,
  });
  modal.open({ id: 'p1', label: PROCESSES[0]!.cmd, type: 'exec', status: 'running', elapsedMs: 185_000 });
  return over(renderLiveTailModal(modal, width, height), width, height, onBase);
}

export function fixtureSettings(width: number, height: number, onBase = false, query = ''): Line[] {
  const root = makeProjectTempDir(`gv-golden-settings-${Date.now()}`);
  const originalHome = process.env['HOME'];
  process.env['HOME'] = root;
  try {
    const cm = new ConfigManager({ surfaceRoot: 'agent', workingDir: root, homeDir: root, configDir: join(root, '.goodvibes', 'agent') });
    const subscriptionManager = new SubscriptionManager(join(root, '.goodvibes', 'agent', 'subscriptions.json'));
    const serviceRegistry = new ServiceRegistry(join(root, '.goodvibes', 'agent', 'services.json'), {
      secretsManager: new SecretsManager({ projectRoot: root, globalHome: root, configManager: cm }),
      subscriptionManager,
    });
    const mcpRegistry = { listServerSecurity: () => [], setServerTrustMode: () => {} } as unknown as McpRegistry;
    const modal = new SettingsModal();
    modal.open(cm, createFeatureFlagManager(), subscriptionManager, serviceRegistry, mcpRegistry);
    modal.focusSettings();
    modal.moveDown();
    if (query) modal.setSearchQuery(query);
    return over(renderSettingsModal(modal, width, height), width, height, onBase);
  } finally {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
  }
}

function model(overrides: Partial<ModelDefinition>): ModelDefinition {
  return {
    id: 'claude-opus-4', provider: 'anthropic', registryKey: 'anthropic:claude-opus-4', displayName: 'Claude Opus 4',
    description: '', capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: true },
    contextWindow: 1_000_000, selectable: true, tier: 'premium',
    ...overrides,
  } as ModelDefinition;
}

export function fixtureModelPicker(width: number, height: number, onBase = false): Line[] {
  const picker = new ModelPickerModal(
    { getRecentModels: async () => [] } as never,
    { getBenchmarks: () => undefined } as never,
    { getSyntheticModelInfoFromCatalog: () => null } as never,
  );
  picker.active = true;
  picker.models = [
    model({}),
    model({ id: 'claude-sonnet-4', registryKey: 'anthropic:claude-sonnet-4', displayName: 'Claude Sonnet 4', contextWindow: 200_000 }),
    model({ id: 'gpt-5', provider: 'openai', registryKey: 'openai:gpt-5', displayName: 'GPT-5', contextWindow: 400_000, tier: 'subscription' }),
    model({ id: 'llama3.1:8b', provider: 'ollama', registryKey: 'ollama:llama3.1:8b', displayName: 'Llama 3.1 8B', contextWindow: 128_000, tier: 'free', capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false } }),
  ];
  picker.providers = ['anthropic', 'openai', 'ollama'];
  picker.configuredProviders = new Set(['anthropic', 'openai', 'ollama']);
  picker.configuredViaMap = new Map([['anthropic', 'subscription'], ['openai', 'env']]);
  picker.setTargetInfos([
    { target: 'main', label: 'Main Chat', description: 'Normal turns.', provider: 'anthropic', model: 'anthropic:claude-opus-4', enabled: true, inherited: false },
    { target: 'helper', label: 'Helper Model', description: 'Helper route.', provider: 'anthropic', model: 'anthropic:claude-sonnet-4', enabled: true, inherited: false },
    { target: 'tool', label: 'Tool LLM', description: 'Tool route.', provider: 'anthropic', model: 'anthropic:claude-opus-4', enabled: false, inherited: true },
    { target: 'tts', label: 'TTS LLM', description: 'Spoken turns.', provider: 'openai', model: 'openai:gpt-5', enabled: true, inherited: true },
  ] as never);
  picker.openAllModels(picker.models, 'anthropic:claude-opus-4');
  return over(renderModelWorkspace(picker, width, height), width, height, onBase);
}

export function fixtureMcpWorkspace(width: number, height: number, onBase = false, form = false): Line[] {
  const workspace = new McpWorkspace();
  workspace.active = true;
  if (form) workspace.openAddForm();
  return over(renderMcpWorkspace(workspace, width, height), width, height, onBase);
}

function workspaceContext(): CommandContext {
  return {
    executeCommand: async () => true,
    print: () => undefined,
    session: {},
    provider: {},
    workspace: {},
    platform: {},
    ops: {},
    extensions: {},
  } as unknown as CommandContext;
}

export function fixtureAgentWorkspace(width: number, height: number, onBase = false): Line[] {
  const workspace = new AgentWorkspace();
  workspace.open(workspaceContext(), () => undefined);
  return over(renderAgentWorkspace(workspace, width, height), width, height, onBase);
}

export function fixturePermissionPrompt(width: number, height: number, onBase = false): Line[] {
  const request = {
    callId: 'call-1',
    tool: 'exec',
    args: { command: 'rsync -a ~/Photos/2026 /mnt/backup/photos --delete' },
    category: 'execute',
    workingDirectory: '/workspace/assistant',
    analysis: {
      classification: 'execute',
      riskLevel: 'high',
      summary: 'Mirror the photo folder to the backup drive, deleting files there that are gone here.',
      reasons: ['--delete removes files on the backup drive that no longer exist in ~/Photos/2026.'],
      target: 'rsync -a ~/Photos/2026 /mnt/backup/photos --delete',
      targetKind: 'command',
      sideEffects: ['deletes files', 'writes to /mnt/backup'],
    },
  } as unknown as PermissionRequest;
  return over(PermissionPromptUI.createPromptLayer(width, height, request), width, height, onBase);
}

export function fixtureBlockActions(width: number, height: number, onBase = false): Line[] {
  const menu = new BlockActionsMenu();
  menu.open({ blockIndex: 2, collapseKey: 'msg_3', type: 'tool', startLine: 10, lineCount: 12, toolName: 'web_search' } as never);
  return over(renderBlockActionsMenu(menu, width, height), width, height, onBase);
}

export function fixtureActivityView(): ActivityView {
  return {
    now: {
      busy: true,
      label: 'Searching the web for fares to Lisbon',
      agents: [{ label: 'researcher', headline: 'comparing three fares', quietForMs: 240_000 }],
      processes: 2,
    },
    needsYou: ['Approval needed, answer the prompt on screen.'],
    comingUp: ['Reminder: pack the travel adapter, Thursday 08:00'],
    recent: [
      { at: FIXTURE_NOW - 60_000, kind: 'delivery', priority: 'high', text: '[Telegram] Reminder delivered to @owner' },
      { at: FIXTURE_NOW - 300_000, kind: 'schedule', priority: 'normal', text: '[Schedule] Morning brief ran at 07:30' },
      { at: FIXTURE_NOW - 900_000, kind: 'security', priority: 'high', text: '[Security] A new device paired with the daemon' },
    ],
  } as unknown as ActivityView;
}

export function fixtureActivity(width: number, height: number, onBase = false): Line[] {
  return withFixedClock(() => {
    const modal = new ActivityModal({ view: fixtureActivityView });
    return over(modal.render(width, height), width, height, onBase);
  });
}

/** Two modals stacked: the process monitor under the live tail it opened (each dims what is under it). */
export function fixtureStacked(width: number, height: number): Line[] {
  return withFixedClock(() => {
    const processes = new ProcessModal({
      processManager: { list: () => PROCESSES, getStatus: () => ({ startTime: FIXTURE_NOW - 42_000 }), stop: () => true } as never,
    });
    processes.refresh();
    const tail = new LiveTailModal({ processManager: { stop: () => true, getOutput: () => ({ stdout: 'fetching fares...\n3 fares found', stderr: '' }) } as never });
    tail.open({ id: 'p2', label: PROCESSES[1]!.cmd, type: 'exec', status: 'running', elapsedMs: 42_000 });
    const layers = [renderProcessModal(processes, width, height), renderLiveTailModal(tail, width, height)].filter((l): l is SurfaceLayer => l !== null);
    return frameFromLayers(layers, width, height, fixtureBaseScreen(width, height));
  });
}

// ---------------------------------------------------------------------------
// Popups and bars (rows docked above the composer, never dimmed)
// ---------------------------------------------------------------------------

function dock(width: number, height: number, popup: Line[]): Line[] {
  const header = withHeaderGap(UIFactory.createHeader(width, 'claude-opus-4', 'Lisbon trip', FIXTURE_VERSION), width);
  const footer = fixtureFooter(width, { promptText: '/', composerMode: 'command' });
  const room = height - header.length - footer.length;
  // The assistant's answer (from its ◆ marker row down) sits behind the popup.
  const transcript = fixtureTranscript(width);
  const body = transcript.slice(Math.max(0, transcript.findIndex((line) => line.some((cell) => cell.char === '◆'))));
  const visible = body.slice(Math.max(0, body.length - room));
  while (visible.length < room) visible.unshift(createEmptyLine(width));
  // The shell leaves one blank row between the popup and the composer (main.ts bottomDockInset).
  const docked = overlayViewportBottom(visible, popup, width, room, 1);
  while (docked.length < room) docked.push(createEmptyLine(width));
  return [...header, ...docked, ...footer];
}

export function fixtureSlashPopup(width: number, height: number): Line[] {
  const registry = new CommandRegistry();
  registerBuiltinCommands(registry);
  const engine = new AutocompleteEngine(registry);
  engine.update('re');
  return dock(width, height, renderAutocompleteOverlay(engine, width, height - 7));
}

export function fixtureFilePopup(width: number, height: number): Line[] {
  const picker = new FilePickerModal({ workingDirectory: '/workspace/assistant' });
  picker.active = true;
  picker.query = 'pack';
  picker.results = ['notes/packing-list.md', 'trips/lisbon/packing.md', 'archive/2025/packing-old.md'];
  picker.selectedIndex = 1;
  return dock(width, height, renderFilePickerOverlay(picker, width, height - 7));
}

export function fixtureHistorySearch(width: number): Line[] {
  const search = new HistorySearch(() => ['remind me to call the dentist', 'find me a flight to Lisbon', 'what is on my calendar today']);
  search.open('');
  search.search('flight');
  return renderHistorySearchOverlay(search, width);
}

export function fixtureFindBar(width: number, locked: boolean): Line[] {
  const manager = new SearchManager();
  manager.active = true;
  manager.query = 'Lisbon';
  if (locked) manager.lock();
  return renderSearchOverlay(manager, width);
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export function fixtureCodeBlock(width: number): Line[] {
  return renderCodeBlock([
    'const reminder = { text: "pack the adapter", at: "2026-10-01T08:00" };',
    'await schedule(reminder); // a very long trailing comment that runs right up to the edge of the fill',
  ], 'ts', width);
}

export function fixtureDiffView(width: number): Line[] {
  return renderDiffView([
    '--- a/notes/packing-list.md',
    '+++ b/notes/packing-list.md',
    '@@ -1,3 +1,4 @@',
    ' - passport',
    '-- charger',
    '+- phone charger',
    '+- travel adapter (EU)',
    ' - sunglasses',
  ].join('\n'), width, 'notes/packing-list.md');
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

export interface FrameFixture {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly render: () => Line[];
}

function sizes(name: string, render: (w: number, h: number) => Line[]): FrameFixture[] {
  return [
    { name: `${name}-120x40`, width: 120, height: 40, render: () => render(120, 40) },
    { name: `${name}-80x24`, width: 80, height: 24, render: () => render(80, 24) },
  ];
}

/** Every golden frame, by name. */
export function frameFixtures(): FrameFixture[] {
  return [
    { name: 'home-screen-100x30', width: 100, height: 30, render: () => fixtureHomeScreen(100, 30) },
    { name: 'home-screen-60x24', width: 60, height: 24, render: () => fixtureHomeScreen(60, 24) },
    ...sizes('base-screen', (w, h) => fixtureBaseScreen(w, h)),
    { name: 'base-screen-busy-120x40', width: 120, height: 40, render: () => fixtureBaseScreen(120, 40, { turnRunning: true, throbber: { spinner: '⠋', frame: 0, activity: { kind: 'model', phrase: 'Thinking', elapsedMs: 12_400, tokenSpeed: 48 } } }) },
    { name: 'base-screen-context-hot-90x24', width: 90, height: 24, render: () => fixtureBaseScreen(90, 24, { lastInputTokens: 870_000, powerNote: 'sleep disabled', runningAgentCount: 1, runningProcessCount: 2 }) },
    ...sizes('selection-modal', (w, h) => fixtureSelectionModal(w, h)),
    ...sizes('session-picker', (w, h) => fixtureSessionPicker(w, h)),
    ...sizes('profile-picker', (w, h) => fixtureProfilePicker(w, h)),
    ...sizes('bookmarks', (w, h) => fixtureBookmarks(w, h)),
    ...sizes('context-inspector', (w, h) => fixtureContextInspector(w, h)),
    ...sizes('help', (w, h) => fixtureHelp(w, h)),
    { name: 'help-query-120x40', width: 120, height: 40, render: () => fixtureHelp(120, 40, false, 'remind') },
    ...sizes('shortcuts', (w, h) => fixtureShortcuts(w, h)),
    ...sizes('process-monitor', (w, h) => fixtureProcessModal(w, h)),
    ...sizes('live-tail', (w, h) => fixtureLiveTail(w, h)),
    ...sizes('settings', (w, h) => fixtureSettings(w, h)),
    { name: 'settings-search-120x40', width: 120, height: 40, render: () => fixtureSettings(120, 40, false, 'theme') },
    ...sizes('model-picker', (w, h) => fixtureModelPicker(w, h)),
    ...sizes('mcp-workspace', (w, h) => fixtureMcpWorkspace(w, h)),
    { name: 'mcp-workspace-form-120x40', width: 120, height: 40, render: () => fixtureMcpWorkspace(120, 40, false, true) },
    ...sizes('agent-workspace', (w, h) => fixtureAgentWorkspace(w, h)),
    ...sizes('permission-prompt', (w, h) => fixturePermissionPrompt(w, h)),
    ...sizes('block-actions', (w, h) => fixtureBlockActions(w, h)),
    ...sizes('activity', (w, h) => fixtureActivity(w, h)),
    { name: 'stacked-modals-120x40', width: 120, height: 40, render: () => fixtureStacked(120, 40) },
    { name: 'slash-popup-100x30', width: 100, height: 30, render: () => fixtureSlashPopup(100, 30) },
    { name: 'file-popup-100x30', width: 100, height: 30, render: () => fixtureFilePopup(100, 30) },
    { name: 'history-search-100x1', width: 100, height: 1, render: () => fixtureHistorySearch(100) },
    { name: 'find-bar-100x1', width: 100, height: 1, render: () => fixtureFindBar(100, true) },
    { name: 'code-block-100', width: 100, height: 5, render: () => fixtureCodeBlock(100) },
    { name: 'diff-view-100', width: 100, height: 11, render: () => fixtureDiffView(100) },
  ];
}
