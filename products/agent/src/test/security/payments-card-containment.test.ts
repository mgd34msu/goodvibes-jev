import { withOfflineProviderMetadata } from '../helpers/offline-provider-metadata.ts';
import { useSecurityReadings } from '../helpers/security-readings.ts';
/**
 * Containment tests for the payment card material entered at the agent's
 * terminal: a value stored through the daemon secret path must never appear in
 * plaintext anywhere else, not on screen while it is being typed, not in the
 * transcript, not in input history, not in a log line, not in the support
 * bundle this app can export.
 *
 * They also prove the two properties that make the feature actually work
 * rather than merely look safe:
 *
 *   - every card secret this surface writes lands at DAEMON scope, and the
 *     config reference lands in the DAEMON-owned config tier, a real file on
 *     disk that the daemon reads with this program not running; and
 *   - card material is refused on the way OUT to a remote messaging channel,
 *     with the refusal never quoting what it refused.
 *
 * Every test drives REAL production code, the actual composer key-route
 * handler, the actual InputHandler, the actual settings-modal render function,
 * the actual `/payments` command handler, the actual outbound delivery funnel,
 * the actual redaction functions the bundle export runs through, not a mock
 * standing in for them.
 *
 * The fake values below are not real card numbers or codes.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { SubscriptionManager, ServiceRegistry } from '@goodvibes-jev/engine/sdk/platform/config';
import {
  mayEnterCardDetails,
  mayOfferCardEntryFlow,
  describeCardEntryRefusal,
} from '@goodvibes-jev/engine/sdk/platform/payments';
import { SecretsManager } from '../../config/secrets.ts';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { McpRegistry } from '@goodvibes-jev/engine/sdk/platform/mcp';
import { SettingsModal } from '../../input/settings-modal.ts';
import { renderSettingsModal } from '../../renderer/settings-modal.ts';
import { layerText } from '../helpers/surface-frame.ts';
import { linesToText } from '../setup.ts';
import {
  buildGoodVibesSecretKey,
  defaultSecretBackedScope,
  isSecretReferenceValue,
  persistSecretBackedConfigValue,
} from '../../config/secret-config.ts';
import type { SecretScope } from '../../config/secrets.ts';
import { setSecretBackedSettingValue } from '../../input/settings-modal-secrets.ts';
import {
  PAYMENTS_CARD_CVV_CONFIG_KEY,
  PAYMENTS_CARD_NUMBER_CONFIG_KEY,
  paymentsAddressConfigKey,
  paymentsAddressConfigKeys,
} from '../../input/payments-config.ts';
import {
  runPaymentsCommand,
  startCardEntryFlow,
  startAddressEntryFlow,
  CARD_ENTRY_SURFACE,
  CARD_SECRET_FIELDS,
} from '../../input/commands/payment-card-intake.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { handleCommandModeToken } from '../../input/handler-command-route.ts';
import { registerPaymentCardCommands } from '../../input/commands/payment-card-intake.ts';
import { handlePromptKeyToken, type KeyRouteState } from '../../input/handler-feed-routes.ts';
import { InputHistory } from '../../input/input-history.ts';
import {
  maskConcealedText,
  beginConcealedInputFor,
  submitConcealedInputFor,
  cancelConcealedInputFor,
  type ConcealedInputHost,
} from '../../input/concealed-input.ts';
import { redactConfig, collectSensitiveConfigValues, redactSerializedSecrets, REDACTED_VALUE } from '../../cli/redaction.ts';
import { deliverAgentChannelMessage } from '../../agent/channel-delivery.ts';
import {
  screenOutboundForCardMaterial,
  resolveDeliverySurfaceName,
  mayOfferCardEntryOnDelivery,
  CardMaterialRefusedError,
} from '../../agent/payments-channel-guard.ts';
import { handleBundleCommand } from '../../cli/bundle-command.ts';
import { parseGoodVibesCli } from '../../cli/parser.ts';
import { InputHandler } from '../../input/handler.ts';
import { SelectionManager } from '@goodvibes-jev/engine/terminal-shell';
import { InfiniteBuffer } from '@goodvibes-jev/engine/terminal-shell';
import { createDefaultUiRuntimeServices } from '../helpers/ui-services.ts';

const FAKE_CVV = '731';

/**
 * A leaked digit value shows up as its own digit run, never embedded inside a
 * longer one: epoch-milli timestamps in dumps, temp paths, and mock-call
 * serializations currently contain "731" (epochs 1787318... do, for days at a
 * stretch), so a raw substring scan over a composite payload flags time, not
 * leaks. Exact-echo assertions on single values keep plain matching.
 */
function leakedDigits(haystack: string, digits: string): boolean {
  return new RegExp(`(?<!\\d)${digits}(?!\\d)`).test(haystack);
}

// Deliberately NOT the command's own placeholder example (4242424242424242,
// printed as static guidance before any input): a different fake here means a
// transcript match on THIS value can only be a real echo of what was typed,
// never a coincidental match against the always-printed example text.
const FAKE_CARD_NUMBER = '4000056655665556';
// Also deliberately distinct from the command's placeholder ("e.g. 12/34").
const FAKE_EXPIRY = '09/29';
const FAKE_CARDHOLDER = 'Jane Q. Fakename';

const W = 140;

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gv-payments-card-containment-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createConfigManager(root: string): ConfigManager {
  return new ConfigManager({
    surfaceRoot: 'agent',
    workingDir: root,
    homeDir: root,
    configDir: join(root, '.goodvibes', 'global-agent'),
  });
}

describe('payments card containment (agent terminal)', () => {
  useSecurityReadings();
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let tmpDir: string;
  let cm: ConfigManager;
  let secrets: SecretsManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    process.env.HOME = tmpDir;
    process.chdir(tmpDir);
    cm = createConfigManager(tmpDir);
    secrets = new SecretsManager({
      projectRoot: tmpDir,
      globalHome: tmpDir,
      daemonHome: join(tmpDir, '.goodvibes', 'daemon'),
      configManager: cm,
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. Storage, a reference in config, the value at daemon scope, and the
  //    reference itself in the daemon-owned tier the daemon actually reads.
  // -------------------------------------------------------------------------

  test('storing the CVV writes a goodvibes:// reference to the real ConfigManager, never the raw value', async () => {
    const stored = await persistSecretBackedConfigValue(cm, secrets, PAYMENTS_CARD_CVV_CONFIG_KEY, FAKE_CVV, { scope: 'daemon' });
    expect(stored).not.toBe(FAKE_CVV);
    expect(isSecretReferenceValue(stored)).toBe(true);

    const configValue = cm.get(PAYMENTS_CARD_CVV_CONFIG_KEY);
    expect(configValue).toBe(stored);
    expect(String(configValue)).not.toContain(FAKE_CVV);

    // Functional correctness: the reference actually resolves to the value.
    const secretKey = buildGoodVibesSecretKey(PAYMENTS_CARD_CVV_CONFIG_KEY);
    expect(await secrets.get(secretKey)).toBe(FAKE_CVV);
  });

  test('the card reference lands in the DAEMON-owned config tier: the file the daemon reads with this program closed', async () => {
    const stored = await persistSecretBackedConfigValue(cm, secrets, PAYMENTS_CARD_NUMBER_CONFIG_KEY, FAKE_CARD_NUMBER, { scope: 'daemon' });

    const daemonTierPath = cm.getDaemonTierPath();
    expect(daemonTierPath).not.toBeNull();
    const daemonRaw = JSON.parse(readFileSync(daemonTierPath!, 'utf-8')) as { payments?: { cardNumber?: unknown } };
    expect(daemonRaw.payments?.cardNumber).toBe(stored);
    // and the value is not sitting in that file either
    expect(readFileSync(daemonTierPath!, 'utf-8')).not.toContain(FAKE_CARD_NUMBER);
  });

  test('defaultSecretBackedScope sends daemon-owned keys to daemon scope and leaves client-owned keys at user scope', () => {
    // This is the regression the whole feature rests on: with these defaulting
    // to 'user', the reference lands in the daemon's settings file while the
    // value it points at sits in a tier the daemon never resolves. The surface
    // reports success; the daemon finds nothing.
    expect(defaultSecretBackedScope(PAYMENTS_CARD_CVV_CONFIG_KEY)).toBe('daemon' satisfies SecretScope);
    expect(defaultSecretBackedScope(PAYMENTS_CARD_NUMBER_CONFIG_KEY)).toBe('daemon' satisfies SecretScope);
    expect(defaultSecretBackedScope('surfaces.telegram.botToken' as never)).toBe('daemon' satisfies SecretScope);
    expect(defaultSecretBackedScope('provider.model' as never)).toBe('user' satisfies SecretScope);
  });

  test('the settings-modal secret edit path also writes at daemon scope: not just the /payments card path', () => {
    const scopes: (string | undefined)[] = [];
    const fakeSecrets = {
      set: mock(async (_k: string, _v: string, opts?: { scope?: string }) => { scopes.push(opts?.scope); }),
      delete: mock(async (_k: string, opts?: { scope?: string }) => { scopes.push(opts?.scope); }),
    };
    setSecretBackedSettingValue({
      key: PAYMENTS_CARD_CVV_CONFIG_KEY,
      value: FAKE_CVV,
      configManager: cm,
      secretsManager: fakeSecrets as never,
      setConfigValue: (k, v) => cm.setDynamic(k, v),
    });
    expect(scopes).toContain('daemon');
    expect(String(cm.get(PAYMENTS_CARD_CVV_CONFIG_KEY))).not.toContain(FAKE_CVV);
  });

  test('a guided address field lands in the daemon-owned tier too: the daemon needs somewhere to ship to', () => {
    const key = paymentsAddressConfigKey('shipping', 'line1');
    cm.setDynamic(key, '123 Fake St');
    const daemonTierPath = cm.getDaemonTierPath();
    expect(daemonTierPath).not.toBeNull();
    const daemonRaw = JSON.parse(readFileSync(daemonTierPath!, 'utf-8')) as { payments?: { shippingAddress?: { line1?: unknown } } };
    expect(daemonRaw.payments?.shippingAddress?.line1).toBe('123 Fake St');
  });

  // -------------------------------------------------------------------------
  // 2. Nothing is echoed during entry.
  // -------------------------------------------------------------------------

  test('the composer masks a concealed buffer to bullets of the same length: no plaintext character reaches the screen', () => {
    const host: ConcealedInputHost = { prompt: '', cursorPos: 0, concealedInput: null, requestRender: () => {} };
    beginConcealedInputFor(host, { label: 'CVV', onSubmit: () => {} });
    host.prompt = FAKE_CVV;

    const masked = maskConcealedText(host.prompt);
    expect(masked).not.toContain(FAKE_CVV);
    expect(masked).toBe('•'.repeat(FAKE_CVV.length));
    // Length preserved so cursor math and wrapping stay correct.
    expect(masked.length).toBe(FAKE_CVV.length);
    expect(maskConcealedText(FAKE_CARD_NUMBER)).toBe('•'.repeat(FAKE_CARD_NUMBER.length));
  });

  test('the concealed value is cleared from the composer BEFORE it is handed to the requester', () => {
    const observed: { promptAtCallbackTime: string | null } = { promptAtCallbackTime: null };
    const host: ConcealedInputHost = { prompt: '', cursorPos: 0, concealedInput: null, requestRender: () => {} };
    beginConcealedInputFor(host, {
      label: 'CVV',
      onSubmit: () => { observed.promptAtCallbackTime = host.prompt; },
    });
    host.prompt = FAKE_CVV;
    expect(submitConcealedInputFor(host, FAKE_CVV)).toBe(true);

    expect(observed.promptAtCallbackTime).toBe('');
    expect(host.prompt).toBe('');
    expect(host.concealedInput).toBeNull();
  });

  test('cancelling a concealed prompt clears the buffer and never leaks the partial value', () => {
    let cancelled = false;
    const host: ConcealedInputHost = { prompt: '', cursorPos: 0, concealedInput: null, requestRender: () => {} };
    beginConcealedInputFor(host, { label: 'CVV', onSubmit: () => {}, onCancel: () => { cancelled = true; } });
    host.prompt = FAKE_CVV;
    expect(cancelConcealedInputFor(host)).toBe(true);
    expect(cancelled).toBe(true);
    expect(host.prompt).toBe('');
    expect(host.concealedInput).toBeNull();
  });

  test('the REAL InputHandler renders a concealed card number as bullets: the masking is wired, not just available', () => {
    const sel = new SelectionManager();
    const history = new InfiniteBuffer();
    const input = new InputHandler(() => {}, sel, () => 0, () => 20, () => history, () => {}, () => {}, createDefaultUiRuntimeServices());
    input.setContentWidth(60);

    input.beginConcealedInput({ label: 'Card number', onSubmit: () => {} });
    input.prompt = FAKE_CARD_NUMBER;
    input.cursorPos = FAKE_CARD_NUMBER.length;

    const info = input.getWrappedPromptInfo(60);
    const rendered = info.visibleLines.join('\n');
    expect(rendered).not.toContain(FAKE_CARD_NUMBER);
    expect(rendered).toBe('•'.repeat(FAKE_CARD_NUMBER.length));
    // cursor coordinates are unchanged by masking
    expect(info.cursorCol).toBe(FAKE_CARD_NUMBER.length);
  });

  test('the REAL InputHandler does NOT mask an ordinary prompt, and does not mask a plain address prompt', () => {
    const sel = new SelectionManager();
    const history = new InfiniteBuffer();
    const input = new InputHandler(() => {}, sel, () => 0, () => 20, () => history, () => {}, () => {}, createDefaultUiRuntimeServices());
    input.setContentWidth(60);

    input.prompt = 'hello world';
    expect(input.getWrappedPromptInfo(60).visibleLines.join('\n')).toContain('hello world');

    // An address field is entered in the clear, see plain-line-input.ts.
    input.beginPlainInput({ label: 'City', onSubmit: () => {} });
    input.prompt = 'Springfield';
    expect(input.getWrappedPromptInfo(60).visibleLines.join('\n')).toContain('Springfield');
  });

  test('beginning a plain prompt cancels a pending concealed one: the two slots are never both live', () => {
    const sel = new SelectionManager();
    const history = new InfiniteBuffer();
    const input = new InputHandler(() => {}, sel, () => 0, () => 20, () => history, () => {}, () => {}, createDefaultUiRuntimeServices());

    let concealedCancelled = false;
    input.beginConcealedInput({ label: 'CVV', onSubmit: () => {}, onCancel: () => { concealedCancelled = true; } });
    input.beginPlainInput({ label: 'City', onSubmit: () => {} });

    expect(concealedCancelled).toBe(true);
    expect(input.concealedInput).toBeNull();
    expect(input.plainLineInput).not.toBeNull();
  });

  test('the REAL InputHandler routes a concealed submission to its requester and clears the buffer', () => {
    const sel = new SelectionManager();
    const history = new InfiniteBuffer();
    const input = new InputHandler(() => {}, sel, () => 0, () => 20, () => history, () => {}, () => {}, createDefaultUiRuntimeServices());

    const observed: { delivered: string | null } = { delivered: null };
    input.beginConcealedInput({ label: 'CVV', onSubmit: (v) => { observed.delivered = v; } });
    input.prompt = FAKE_CVV;

    expect(input.submitConcealedInput(FAKE_CVV)).toBe(true);
    expect(observed.delivered).toBe(FAKE_CVV);
    expect(input.prompt).toBe('');
    expect(input.concealedInput).toBeNull();
    // with nothing pending it declines, so the normal submit path runs
    expect(input.submitConcealedInput('ordinary message')).toBe(false);
  });

  test('Escape cancels a pending card prompt through the real handler, clearing the buffer and unmasking', () => {
    const sel = new SelectionManager();
    const history = new InfiniteBuffer();
    const input = new InputHandler(() => {}, sel, () => 0, () => 20, () => history, () => {}, () => {}, createDefaultUiRuntimeServices());
    input.setContentWidth(60);

    let cancelled = false;
    input.beginConcealedInput({ label: 'CVV', onSubmit: () => {}, onCancel: () => { cancelled = true; } });
    input.prompt = FAKE_CVV;

    // This is what the Escape key route calls. Without it the request dangles:
    // onCancel never fires, the chained flow neither resumes nor stops, and the
    // composer stays silently in masked mode.
    expect(input.cancelConcealedInput()).toBe(true);
    expect(cancelled).toBe(true);
    expect(input.concealedInput).toBeNull();
    expect(input.prompt).toBe('');
    // and with nothing pending it declines, so Escape falls through to the modal stack
    expect(input.cancelConcealedInput()).toBe(false);

    // a plain address prompt is cancellable the same way
    let plainCancelled = false;
    input.beginPlainInput({ label: 'City', onSubmit: () => {}, onCancel: () => { plainCancelled = true; } });
    expect(input.cancelConcealedInput()).toBe(true);
    expect(plainCancelled).toBe(true);
  });

  test('END TO END: typing /payments card puts the REAL composer into masked mode and stores at daemon scope', async () => {
    // Everything above tests one link. This drives the whole chain the way a
    // person does: slash-command mode consumes the Enter that runs the command,
    // the command asks the live InputHandler for a masked line, the next Enter
    // is diverted to that request instead of the chat/history path, and the
    // value lands in the daemon secret store.
    //
    // The link this specifically protects is the handoff: handleCommandModeToken
    // runs BEFORE handlePromptKeyToken in the feed loop, so if it did not clear
    // commandMode before executing the command, the very next Enter would be
    // eaten as another command and the card prompt would never receive it.
    const sel = new SelectionManager();
    const history = new InfiniteBuffer();
    const input = new InputHandler(() => {}, sel, () => 0, () => 20, () => history, () => {}, () => {}, createDefaultUiRuntimeServices());
    input.setContentWidth(80);

    const printed: string[] = [];
    const ctx = {
      print: (t: string) => printed.push(t),
      renderRequest: () => {},
      beginConcealedInput: (request: never) => input.beginConcealedInput(request),
      beginPlainInput: (request: never) => input.beginPlainInput(request),
      platform: { configManager: cm, secretsManager: secrets },
    } as unknown as CommandContext;

    const registry = new CommandRegistry();
    registerPaymentCardCommands(registry);

    const modalStack = ['command'];
    const commandState = {
      commandMode: true,
      prompt: '/payments card',
      cursorPos: '/payments card'.length,
      autocomplete: null,
      modalStack,
      commandRegistry: registry,
      commandContext: ctx,
      conversationManager: { log: () => {} } as never,
      requestRender: () => {},
      handleEscape: () => {},
      projectRoot: tmpDir,
      pasteRegistry: new Map<string, string>(),
      imageRegistry: new Map<string, { data: string; mediaType: string }>(),
      nextPasteId: 1,
      nextImageId: 1,
      saveUndoState: () => {},
      ensureInputCursorVisible: () => {},
    };

    expect(handleCommandModeToken(commandState as never, { type: 'key', logicalName: 'enter' } as never)).toBe(true);
    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    // command mode released, and the composer is now waiting for a masked line
    expect(commandState.commandMode).toBe(false);
    expect(input.concealedInput).not.toBeNull();
    expect(input.concealedInput?.label).toBe('Card number');

    // typing the number shows bullets, not the number
    input.prompt = FAKE_CARD_NUMBER;
    input.cursorPos = FAKE_CARD_NUMBER.length;
    expect(input.getWrappedPromptInfo(80).visibleLines.join('\n')).not.toContain(FAKE_CARD_NUMBER);

    // Enter is diverted to the card request, never to input history
    const historySpy = new InputHistory({ historyPath: join(tmpDir, 'ih.json'), persist: false });
    const addSpy = spyOn(historySpy, 'add');
    const route = handlePromptKeyToken({
      prompt: input.prompt,
      cursorPos: input.cursorPos,
      inputScrollTop: 0,
      commandMode: commandState.commandMode,
      contentWidth: 80,
      maxInputRows: 8,
      inputHistory: historySpy,
      indicatorFocused: false,
      conversationManager: null,
      commandContext: undefined,
      autocomplete: null,
      blockActionsMenu: { open: () => {} },
      processModal: { open: () => {} },
      modalOpened: () => {},
      saveUndoState: () => {},
      ensureInputCursorVisible: () => {},
      getWrappedPromptInfo: (w: number) => input.getWrappedPromptInfo(w),
      moveCursorVertical: () => false,
      handlePathCompletion: () => false,
      handleBlockToggle: () => {},
      findMarkerAtPos: () => null,
      cleanupMarkerRegistry: () => {},
      expandPrompt: (t: string) => t,
      submitConcealedInput: (value: string) => input.submitConcealedInput(value),
      scroll: () => {},
      exitApp: () => {},
      requestRender: () => {},
    } as unknown as KeyRouteState, { type: 'key', logicalName: 'enter' } as never);
    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    expect(route.handled).toBe(true);
    expect(route.prompt).toBe('');
    expect(addSpy).not.toHaveBeenCalled();

    // it was really stored, at daemon scope, as a reference
    const storedRef = cm.get(PAYMENTS_CARD_NUMBER_CONFIG_KEY);
    expect(isSecretReferenceValue(String(storedRef))).toBe(true);
    expect(await secrets.get(buildGoodVibesSecretKey(PAYMENTS_CARD_NUMBER_CONFIG_KEY))).toBe(FAKE_CARD_NUMBER);

    // nothing printed carries the number, and the flow moved to the next field
    expect(printed.join('\n')).not.toContain(FAKE_CARD_NUMBER);
    expect(input.concealedInput?.label).toBe('Expiry (MM/YY)');
  });

  test('the settings modal masks a card value mid-edit, not only at rest', () => {
    const ffm: FeatureFlagManager = createFeatureFlagManager();
    const modal = new SettingsModal();
    const subscriptionManager = new SubscriptionManager(join(tmpDir, '.goodvibes', 'agent', 'subscriptions.json'));
    const serviceRegistry = new ServiceRegistry(join(tmpDir, '.goodvibes', 'agent', 'services.json'), {
      secretsManager: secrets,
      subscriptionManager,
    });
    const mcpRegistry = { listServerSecurity: () => [], setServerTrustMode: () => {} } as unknown as McpRegistry;
    mkdirSync(join(tmpDir, '.goodvibes', 'agent'), { recursive: true });

    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    while (modal.currentCategory !== 'payments') modal.nextCategory();

    const cvvIndex = modal.currentItems.findIndex((e) => e.setting.key === PAYMENTS_CARD_CVV_CONFIG_KEY);
    expect(cvvIndex).toBeGreaterThanOrEqual(0);
    while (modal.selectedIndex !== cvvIndex) modal.moveDown();

    modal.activateSelected();
    expect(modal.editingMode).toBe(true);
    for (const ch of FAKE_CVV) modal.editChar(ch);

    const frame = layerText(renderSettingsModal(modal, W, 40)).join('\n');
    expect(leakedDigits(frame, FAKE_CVV)).toBe(false);
    expect(frame).toContain('•'.repeat(FAKE_CVV.length));
  });

  // -------------------------------------------------------------------------
  // 3. Nothing reaches input history.
  // -------------------------------------------------------------------------

  test('a concealed submission never reaches the composer input history', () => {
    const history = new InputHistory({ historyPath: join(tmpDir, 'input-history.json'), persist: false });
    const addSpy = spyOn(history, 'add');
    const observed: { delivered: string | null } = { delivered: null };

    const state: KeyRouteState = {
      prompt: FAKE_CARD_NUMBER,
      cursorPos: FAKE_CARD_NUMBER.length,
      inputScrollTop: 0,
      commandMode: false,
      contentWidth: W,
      maxInputRows: 8,
      inputHistory: history,
      indicatorFocused: false,
      conversationManager: null,
      commandContext: undefined,
      autocomplete: null,
      blockActionsMenu: { open: () => {} },
      processModal: { open: () => {} },
      modalOpened: () => {},
      saveUndoState: () => {},
      ensureInputCursorVisible: () => {},
      getWrappedPromptInfo: () => ({ wrappedLines: [], visibleLines: [], cursorLine: 0, cursorCol: 0, totalLines: 0 }) as never,
      moveCursorVertical: () => false,
      handlePathCompletion: () => false,
      handleBlockToggle: () => {},
      findMarkerAtPos: () => null,
      cleanupMarkerRegistry: () => {},
      expandPrompt: (t) => t,
      submitConcealedInput: (value) => { observed.delivered = value; return true; },
      scroll: () => {},
      exitApp: () => {},
      requestRender: () => {},
    };

    const result = handlePromptKeyToken(state, { type: 'key', logicalName: 'enter' } as never);

    expect(result.handled).toBe(true);
    expect(observed.delivered).toBe(FAKE_CARD_NUMBER);
    expect(addSpy).not.toHaveBeenCalled();
    expect(history.getEntries()).toEqual([]);
    expect(result.prompt).toBe('');
  });

  // -------------------------------------------------------------------------
  // 4. Nothing reaches a log line.
  // -------------------------------------------------------------------------

  test('a failed card store logs the key and the error, never the value', async () => {
    const errorSpy = spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const throwingSecrets = {
        set: async () => { throw new Error('secret store unavailable'); },
        delete: async () => {},
      };
      setSecretBackedSettingValue({
        key: PAYMENTS_CARD_CVV_CONFIG_KEY,
        value: FAKE_CVV,
        configManager: cm,
        secretsManager: throwingSecrets as never,
        setConfigValue: (k, v) => cm.setDynamic(k, v),
      });
      await Promise.resolve();
      await Promise.resolve();

      const serialized = JSON.stringify(errorSpy.mock.calls);
      expect(leakedDigits(serialized, FAKE_CVV)).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  // 5. Nothing reaches the transcript.
  // -------------------------------------------------------------------------

  function makeCommandContext(overrides: Partial<CommandContext> = {}): {
    ctx: CommandContext;
    printed: string[];
    concealedOffers: string[];
    submitField: (value: string) => Promise<void>;
  } {
    const printed: string[] = [];
    const concealedOffers: string[] = [];
    let pendingSubmit: ((value: string) => void) | null = null;

    const ctx = {
      print: (text: string) => { printed.push(text); },
      renderRequest: () => {},
      beginConcealedInput: (request: { label?: string; onSubmit: (v: string) => void }) => {
        concealedOffers.push(request.label ?? '');
        pendingSubmit = request.onSubmit;
      },
      beginPlainInput: (request: { label?: string; onSubmit: (v: string) => void }) => {
        pendingSubmit = request.onSubmit;
      },
      platform: { configManager: cm, secretsManager: secrets },
      ...overrides,
    } as unknown as CommandContext;

    const submitField = async (value: string): Promise<void> => {
      const fn = pendingSubmit;
      pendingSubmit = null;
      fn?.(value);
      // let the persist promise chain settle before the next assertion
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    };

    return { ctx, printed, concealedOffers, submitField };
  }

  test('the /payments card transcript never prints any card field it just stored', async () => {
    const { ctx, printed, submitField } = makeCommandContext();
    startCardEntryFlow(ctx);

    const values = [FAKE_CARD_NUMBER, FAKE_EXPIRY, FAKE_CVV, FAKE_CARDHOLDER];
    for (const value of values) await submitField(value);

    const transcript = printed.join('\n');
    for (const value of values) expect(transcript).not.toContain(value);

    // and every field really was stored (the flow works, it is not just quiet)
    for (let i = 0; i < CARD_SECRET_FIELDS.length; i += 1) {
      const key = CARD_SECRET_FIELDS[i]!.key;
      const stored = cm.get(key);
      expect(isSecretReferenceValue(String(stored))).toBe(true);
      expect(await secrets.get(buildGoodVibesSecretKey(key))).toBe(values[i]);
    }
  });

  test('/payments status reports set / not set and never a value, not even a partial one', async () => {
    await persistSecretBackedConfigValue(cm, secrets, PAYMENTS_CARD_NUMBER_CONFIG_KEY, FAKE_CARD_NUMBER, { scope: 'daemon' });
    const { ctx, printed } = makeCommandContext();
    runPaymentsCommand([], ctx);

    const transcript = printed.join('\n');
    expect(transcript).toContain('set');
    expect(transcript).not.toContain(FAKE_CARD_NUMBER);
    // not even the last four
    expect(leakedDigits(transcript, FAKE_CARD_NUMBER.slice(-4))).toBe(false);
  });

  test('the guided address flow stores what was typed and shows it back: an address is not a credential', async () => {
    const { ctx, printed, submitField } = makeCommandContext();
    startAddressEntryFlow(ctx, 'billing');

    await submitField('Jane Doe');
    await submitField('123 Fake St');

    expect(cm.get(paymentsAddressConfigKey('billing', 'name'))).toBe('Jane Doe');
    expect(cm.get(paymentsAddressConfigKey('billing', 'line1'))).toBe('123 Fake St');
    expect(printed.join('\n')).toContain('123 Fake St');
  });

  /** Read a config key as an opaque value, so an assertion is not narrowed by the key's declared type. */
  function readConfigKey(key: string): unknown {
    return cm.get(key as never) as unknown;
  }

  // Two distinct value sets, driven through the real guided flow, with the
  // observable outcome checked PER KEY in both config and the rendered status.
  // The keys are written out rather than assembled so a reader (and the
  // settings-coverage gate) can see exactly which ones are asserted, see
  // verification/settings-behavior-coverage.ts.
  const ADDRESS_CASES = {
    billing: [
      { key: 'payments.billingAddress.name', a: 'Jane Doe', b: 'John Roe' },
      { key: 'payments.billingAddress.line1', a: '123 Fake St', b: '9 Other Rd' },
      { key: 'payments.billingAddress.line2', a: 'Apt 4B', b: 'Unit 2' },
      { key: 'payments.billingAddress.city', a: 'Springfield', b: 'Shelbyville' },
      { key: 'payments.billingAddress.region', a: 'IL', b: 'NY' },
      { key: 'payments.billingAddress.postalCode', a: '62704', b: '10001' },
      { key: 'payments.billingAddress.country', a: 'US', b: 'CA' },
    ],
    shipping: [
      { key: 'payments.shippingAddress.name', a: 'Jane Doe', b: 'John Roe' },
      { key: 'payments.shippingAddress.line1', a: '123 Fake St', b: '9 Other Rd' },
      { key: 'payments.shippingAddress.line2', a: 'Apt 4B', b: 'Unit 2' },
      { key: 'payments.shippingAddress.city', a: 'Springfield', b: 'Shelbyville' },
      { key: 'payments.shippingAddress.region', a: 'IL', b: 'NY' },
      { key: 'payments.shippingAddress.postalCode', a: '62704', b: '10001' },
      { key: 'payments.shippingAddress.country', a: 'US', b: 'CA' },
    ],
  } as const;

  for (const kind of ['billing', 'shipping'] as const) {
    test(`every payments.${kind}Address.* key round-trips its own value through the guided flow, and a second run replaces it`, async () => {
      const cases = ADDRESS_CASES[kind];

      // The flow's prompt order is the same order these are declared in.
      expect(cases.map((c) => c.key)).toEqual(
        paymentsAddressConfigKeys(kind).map((k) => String(k)) as unknown as typeof cases[number]['key'][],
      );

      const first = makeCommandContext();
      startAddressEntryFlow(first.ctx, kind);
      for (const c of cases) await first.submitField(c.a);
      for (const c of cases) expect(readConfigKey(c.key)).toBe(c.a);

      const statusA = makeCommandContext();
      runPaymentsCommand(['status'], statusA.ctx);
      for (const c of cases) expect(statusA.printed.join('\n')).toContain(c.a);

      // a second run drives every key to a DIFFERENT value; the outcome changes
      const second = makeCommandContext();
      startAddressEntryFlow(second.ctx, kind);
      for (const c of cases) await second.submitField(c.b);
      for (const c of cases) {
        expect(readConfigKey(c.key)).toBe(c.b);
        expect(readConfigKey(c.key)).not.toBe(c.a);
      }

      const statusB = makeCommandContext();
      runPaymentsCommand(['status'], statusB.ctx);
      const renderedB = statusB.printed.join('\n');
      for (const c of cases) expect(renderedB).toContain(c.b);
      // the replaced values are gone from the rendering, not merely appended to
      expect(renderedB).not.toContain('123 Fake St');
      expect(renderedB).not.toContain('Springfield');
    });
  }

  test('a blank answer keeps the current value rather than clearing the field', async () => {
    cm.setDynamic(paymentsAddressConfigKey('shipping', 'line2'), 'Unit 7');
    const { ctx, submitField } = makeCommandContext();
    startAddressEntryFlow(ctx, 'shipping');

    await submitField('Jane Doe');   // name
    await submitField('1 Main St');  // line1
    await submitField('   ');        // line2, whitespace only, treated as blank

    expect(cm.get(paymentsAddressConfigKey('shipping', 'line2'))).toBe('Unit 7');
  });

  test('the address flow refuses the other address kind and rejects an unknown one', () => {
    const { ctx, printed } = makeCommandContext();
    runPaymentsCommand(['address', 'nonsense'], ctx);
    expect(printed.join('\n')).toContain('Usage: /payments address <billing|shipping>');
    expect(cm.get(paymentsAddressConfigKey('billing', 'line1'))).toBe('');
  });

  // -------------------------------------------------------------------------
  // 6. The entry-surface gate, refused when the SDK says the surface may not
  //    take card details, and the prompt is never even offered.
  // -------------------------------------------------------------------------

  test("this command's own surface is a real entry surface, per the SDK's allowlist", () => {
    expect(CARD_ENTRY_SURFACE).toBe('agent-terminal');
    expect(mayEnterCardDetails(CARD_ENTRY_SURFACE)).toBe(true);
    expect(mayOfferCardEntryFlow(CARD_ENTRY_SURFACE)).toBe(true);
  });

  test('startCardEntryFlow refuses on a non-entry surface and never offers the prompt: the prompt is the harm', () => {
    const { ctx, printed, concealedOffers } = makeCommandContext();
    startCardEntryFlow(ctx, 'telegram');

    expect(concealedOffers).toEqual([]);
    const transcript = printed.join('\n');
    expect(transcript).toBe(describeCardEntryRefusal('telegram'));
    expect(transcript).toContain('telegram');
  });

  test('startCardEntryFlow proceeds normally on the real agent-terminal surface: unchanged behavior', () => {
    const { ctx, concealedOffers } = makeCommandContext();
    startCardEntryFlow(ctx);
    expect(concealedOffers.length).toBeGreaterThan(0);
    expect(concealedOffers[0]).toBe('Card number');
  });

  test('the registered /payments card path uses the same gate (defaults to the real surface)', () => {
    const { ctx, concealedOffers } = makeCommandContext();
    runPaymentsCommand(['card'], ctx);
    expect(concealedOffers.length).toBeGreaterThan(0);
  });

  test('card entry refuses rather than falling back to plaintext when concealed input is unavailable', () => {
    const printed: string[] = [];
    const ctx = {
      print: (t: string) => printed.push(t),
      renderRequest: () => {},
      beginConcealedInput: undefined,
      platform: { configManager: cm, secretsManager: secrets },
    } as unknown as CommandContext;

    startCardEntryFlow(ctx);
    expect(printed.join('\n')).toContain('Concealed input is unavailable');
    expect(String(cm.get(PAYMENTS_CARD_CVV_CONFIG_KEY) ?? '')).not.toContain(FAKE_CVV);
  });

  // -------------------------------------------------------------------------
  // 7. Card material is refused on the way OUT to a remote messaging channel,
  //    without being stored, logged, or quoted back.
  // -------------------------------------------------------------------------

  test('a card-shaped message aimed at Telegram is refused before delivery, and the router is never called', async () => {
    const deliver = mock(async () => 'response-id');
    const router = { deliver, listStrategies: () => [{}] } as never;

    let thrown: unknown = null;
    try {
      await deliverAgentChannelMessage(router, {
        channel: 'telegram',
        message: `here is the card ${FAKE_CARD_NUMBER} exp ${FAKE_EXPIRY}`,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CardMaterialRefusedError);
    expect(deliver).not.toHaveBeenCalled();
  });

  test('the refusal never quotes, echoes or partially masks the value it refused', async () => {
    const refusal = await screenOutboundForCardMaterial({
      surface: 'telegram',
      message: `card ${FAKE_CARD_NUMBER}`,
      title: `exp ${FAKE_EXPIRY}`,
    });
    expect(refusal).not.toBeNull();
    expect(refusal!.reason).not.toContain(FAKE_CARD_NUMBER);
    expect(refusal!.reason).not.toContain(FAKE_CARD_NUMBER.slice(-4));
    expect(refusal!.reason).not.toContain(FAKE_EXPIRY);
    expect(refusal!.reason).toBe(describeCardEntryRefusal('telegram'));
    // shapes only, never text
    expect(refusal!.matched).toContain('card-number');
    expect(JSON.stringify(refusal!.matched)).not.toContain(FAKE_CARD_NUMBER);
  });

  test('the thrown error carries the safe refusal wording, so every layer that prints an error is already safe', async () => {
    const router = { deliver: mock(async () => 'id'), listStrategies: () => [] } as never;
    try {
      await deliverAgentChannelMessage(router, { channel: 'slack', message: FAKE_CARD_NUMBER });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(CardMaterialRefusedError);
      expect((error as Error).message).not.toContain(FAKE_CARD_NUMBER);
      expect((error as Error).message).toContain('slack');
    }
  });

  test('the card scan covers the TITLE as well as the body: a title is a message too', async () => {
    const refusal = await screenOutboundForCardMaterial({
      surface: 'discord',
      message: 'nothing to see',
      title: FAKE_CARD_NUMBER,
    });
    expect(refusal).not.toBeNull();
    expect(refusal!.matched).toContain('card-number');
  });

  test('an ordinary message to a remote channel is delivered untouched: the guard is not a blanket block', async () => {
    const deliver = mock(async () => 'response-id');
    const router = { deliver, listStrategies: () => [{}] } as never;
    const result = await deliverAgentChannelMessage(router, {
      channel: 'telegram',
      message: 'Your order shipped. Reply STOP to cancel within 10 minutes.',
    });
    expect(deliver).toHaveBeenCalled();
    expect(result.responseId).toBe('response-id');
  });

  test('an approval prompt still goes out over Telegram: answering is a different axis from entering', async () => {
    const deliver = mock(async () => 'response-id');
    const router = { deliver, listStrategies: () => [{}] } as never;
    await deliverAgentChannelMessage(router, {
      channel: 'telegram',
      message: 'About to buy 1x widget for $19.99. Reply "no" within 10 minutes to cancel.',
    });
    expect(deliver).toHaveBeenCalled();
  });

  test('a webhook target is treated as a remote destination, and an unnameable target fails closed', () => {
    expect(resolveDeliverySurfaceName({ kind: 'webhook' })).toBe('webhook');
    expect(resolveDeliverySurfaceName({ kind: 'surface', surfaceKind: 'telegram' })).toBe('telegram');
    expect(resolveDeliverySurfaceName({ kind: 'surface' })).toBe('unknown-channel');
    expect(mayOfferCardEntryOnDelivery({ kind: 'surface' })).toBe(false);
    expect(mayOfferCardEntryOnDelivery({ kind: 'webhook' })).toBe(false);
  });

  test('no card-entry prompt may be offered toward any remote messaging destination', () => {
    for (const surfaceKind of ['telegram', 'ntfy', 'discord', 'slack', 'whatsapp', 'signal']) {
      expect(mayOfferCardEntryOnDelivery({ kind: 'surface', surfaceKind })).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // 8. Exports and diagnostic dumps.
  // -------------------------------------------------------------------------

  test('the real support-bundle export contains no card value: walked as the actual written payload', async () => {
    await persistSecretBackedConfigValue(cm, secrets, PAYMENTS_CARD_CVV_CONFIG_KEY, FAKE_CVV, { scope: 'daemon' });
    await persistSecretBackedConfigValue(cm, secrets, PAYMENTS_CARD_NUMBER_CONFIG_KEY, FAKE_CARD_NUMBER, { scope: 'daemon' });

    const bundlePath = join(tmpDir, 'bundle.json');
    const { result, requests } = await withOfflineProviderMetadata(() => handleBundleCommand({
      cli: parseGoodVibesCli(['bundle', 'export', bundlePath]),
      configManager: cm,
      workingDirectory: tmpDir,
      homeDirectory: tmpDir,
    }));
    expect(requests.length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(0);
    expect(existsSync(bundlePath)).toBe(true);

    // Grep the real file the owner would attach to a support request.
    const payload = readFileSync(bundlePath, 'utf-8');
    expect(payload).not.toContain(FAKE_CARD_NUMBER);
    expect(payload).not.toContain(FAKE_CARDHOLDER);

    // The CVV is three digits, which collides with substrings of the bundle's
    // own numeric fields (capturedAt is a millisecond timestamp). Grepping the
    // raw text for it would report a leak that is not one, and, worse, would
    // train whoever hits that to weaken the assertion. Every place a CVV could
    // actually live in this payload is a STRING leaf (a config value, a secret
    // name, a diagnostics field), so the check walks string leaves only. That
    // is narrower text but a strictly stronger claim: it cannot be satisfied by
    // a coincidence in a number.
    const stringLeaves: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === 'string') { stringLeaves.push(node); return; }
      if (Array.isArray(node)) { for (const item of node) walk(item); return; }
      if (node !== null && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) { stringLeaves.push(key); walk(value); }
      }
    };
    walk(JSON.parse(payload));
    expect(stringLeaves.length).toBeGreaterThan(50); // the walk actually reached the payload
    expect(stringLeaves.filter((leaf) => leakedDigits(leaf, FAKE_CVV))).toEqual([]);
  }, 60_000);

  test('DEFECT BACKSTOP: a raw literal under payments.card* is redacted by NAME: the suffix list does not catch these', () => {
    // If a future bug ever wrote a literal instead of a reference, this is what
    // stands between it and a file the owner emails to someone.
    const config = {
      payments: {
        cardNumber: FAKE_CARD_NUMBER,
        cardExpiry: FAKE_EXPIRY,
        cardCvv: FAKE_CVV,
        cardholderName: FAKE_CARDHOLDER,
        billingAddress: { line1: '123 Fake St' },
      },
    };

    const redacted = redactConfig(config);
    const serialized = JSON.stringify(redacted.value);
    expect(serialized).not.toContain(FAKE_CARD_NUMBER);
    expect(serialized).not.toContain(FAKE_EXPIRY);
    expect(leakedDigits(serialized, FAKE_CVV)).toBe(false);
    expect(serialized).not.toContain(FAKE_CARDHOLDER);
    expect(redacted.redactedPaths).toContain('payments.cardNumber');
    expect(redacted.redactedPaths).toContain('payments.cardCvv');
    expect(redacted.redactedPaths).toContain('payments.cardholderName');
    expect(serialized).toContain(REDACTED_VALUE);

    // an unrelated, genuinely non-secret field is left alone
    expect(serialized).toContain('123 Fake St');

    // and the same values are collected for the serialized-secret sweep
    const collected = collectSensitiveConfigValues(config);
    expect(collected).toContain(FAKE_CARD_NUMBER);
    expect(redactSerializedSecrets(`leaked ${FAKE_CARD_NUMBER}`, collected)).not.toContain(FAKE_CARD_NUMBER);
  });
});
