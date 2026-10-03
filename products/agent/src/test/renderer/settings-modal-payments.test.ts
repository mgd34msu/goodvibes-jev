/**
 * Rendering tests for the payments settings category: the CVV trade-off
 * warning appears only when prompt is selected, a money value renders exactly
 * as stored with no unit conversion, and no settings surface ever renders a
 * card-material-shaped value.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SettingsModal, SETTINGS_CATEGORIES } from '../../input/settings-modal.ts';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { CVV_PROMPT_TRADEOFF_WARNING } from '@goodvibes-jev/engine/sdk/platform/payments';
import { SecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '@goodvibes-jev/engine/sdk/platform/config';
import { SubscriptionManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { McpRegistry } from '@goodvibes-jev/engine/sdk/platform/mcp';
import { renderSettingsModal } from '../../renderer/settings-modal.ts';
import { layerText } from '../helpers/surface-frame.ts';
import { linesToText } from '../setup.ts';

const W = 140;

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gv-settings-payments-renderer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe('renderSettingsModal payments category', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let tmpDir: string;
  let cm: ConfigManager;
  let ffm: FeatureFlagManager;
  let modal: SettingsModal;
  let mcpRegistry: McpRegistry;
  let subscriptionManager: SubscriptionManager;
  let serviceRegistry: ServiceRegistry;

  function reopen(): void {
    modal.open(cm, ffm, subscriptionManager, serviceRegistry, mcpRegistry);
    while (modal.currentCategory !== 'payments') modal.nextCategory();
  }

  beforeEach(() => {
    tmpDir = makeTmpDir();
    process.env.HOME = tmpDir;
    process.chdir(tmpDir);
    cm = createConfigManager(tmpDir);
    ffm = createFeatureFlagManager();
    modal = new SettingsModal();
    subscriptionManager = new SubscriptionManager(join(tmpDir, '.goodvibes', 'agent', 'subscriptions.json'));
    serviceRegistry = new ServiceRegistry(join(tmpDir, '.goodvibes', 'agent', 'services.json'), {
      secretsManager: new SecretsManager({ projectRoot: tmpDir, globalHome: tmpDir, configManager: cm }),
      subscriptionManager,
    });
    mcpRegistry = { listServerSecurity: () => [], setServerTrustMode: () => {} } as unknown as McpRegistry;
    mkdirSync(join(tmpDir, '.goodvibes', 'agent'), { recursive: true });
    reopen();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('the payments category renders without crashing and shows its keys', () => {
    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'payments.budget.dailyItem');
    const texts = layerText(renderSettingsModal(modal, W, 40)).join('\n');
    expect(texts).toMatch(/Payments\s+36/);
    expect(texts).toContain('payments.budget.dailyItem');
    expect(texts).toContain('Daily Item Budget');
  });

  test('a money field renders the stored amount as-is, with no unit conversion', () => {
    // SDK 2.0.5 removed the minor-unit storage these keys used to have: the
    // stored value already IS the amount a person typed ("19.99" stores as
    // 19.99), so the settings screen renders it exactly like any other
    // number setting rather than reformatting it through a currency table.
    cm.setDynamic('payments.budget.dailyItem', 19.99);
    reopen(); // reload modal.groups from the mutated config, same as resetSelected()'s test pattern
    const texts = layerText(renderSettingsModal(modal, W, 40)).join('\n');
    expect(texts).toContain('19.99');
  });

  test('payments.defaultCardId renders as a plain visible id, never masked like a secret', () => {
    // It refers to a card id from payments.cards.list; the card NUMBER, expiry
    // and CVV live in the daemon secret store and never in config, so this key
    // must never be treated as secret-shaped by the masking path a real secret
    // (surfaces.*.token, etc.) goes through.
    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'payments.defaultCardId');
    const emptyTexts = layerText(renderSettingsModal(modal, W, 40)).join('\n');
    expect(emptyTexts).toContain('(empty)');

    cm.setDynamic('payments.defaultCardId', 'card_household_visa');
    reopen();
    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'payments.defaultCardId');
    const setTexts = layerText(renderSettingsModal(modal, W, 40)).join('\n');
    expect(setTexts).toContain('card_household_visa');
    expect(setTexts).not.toMatch(/•{4,}/);
  });

  test('selecting prompt renders the exact SDK warning text in the context panel', () => {
    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'payments.cvvHandling');
    modal.activateSelected(); // enum cycle: stored -> prompt
    expect(cm.get('payments.cvvHandling')).toBe('prompt');

    const texts = layerText(renderSettingsModal(modal, W, 40)).join('\n');
    expect(texts).toContain('DISABLES UNATTENDED PURCHASING');
    expect(texts).toContain(CVV_PROMPT_TRADEOFF_WARNING.slice(0, 40));
  });

  test('the default (stored) value renders no warning anywhere', () => {
    // The schema's own always-shown description text separately explains what
    // 'prompt' would do (for either value, as documentation), that is not
    // this warning and stays out of this assertion. What must never appear
    // against the 'stored' default is the SDK's moment-of-selection warning
    // string itself.
    modal.selectedIndex = modal.currentItems.findIndex((entry) => entry.setting.key === 'payments.cvvHandling');
    expect(modal.getSelected()?.currentValue).toBe('stored');
    const texts = layerText(renderSettingsModal(modal, W, 40)).join('\n');
    expect(texts).not.toContain(CVV_PROMPT_TRADEOFF_WARNING.slice(0, 40));
  });

  test('the four card-material keys exist only in the payments category, and nowhere else', () => {
    // They used to exist nowhere at all, because this surface had no card entry.
    // It has one now (/payments card, input/commands/payment-card-intake.ts), so
    // the claim worth protecting is no longer "no such key", it is that the
    // keys are confined to payments and that their VALUES never render, which
    // the next test asserts.
    for (const category of SETTINGS_CATEGORIES) {
      if (category === 'flags' || category === 'mcp' || category === 'subscriptions') continue;
      const entries = modal.groups.get(category) ?? [];
      const cardShaped: string[] = entries
        .map((entry) => String(entry.setting.key))
        .filter((key) => /cvv|\bpan\b|cardnumber|cardholder|cardexpiry/i.test(key))
        .filter((key) => key !== 'payments.cvvHandling');
      if (category === 'payments') {
        expect(cardShaped.sort()).toEqual(['payments.cardCvv', 'payments.cardExpiry', 'payments.cardNumber', 'payments.cardholderName'].sort());
      } else {
        expect(cardShaped).toEqual([]);
      }
    }
  });

  test('no category ever renders a card value: masked at rest and masked mid-edit', () => {
    const FAKE_PAN = '4000056655665556';
    const FAKE_CODE = '731';

    // At rest: a stored value is a goodvibes:// reference, but even a raw
    // literal (which only a bug could produce) must not reach the frame.
    cm.setDynamic('payments.cardNumber' as never, FAKE_PAN);
    cm.setDynamic('payments.cardCvv' as never, FAKE_CODE);
    reopen();

    const atRest = layerText(renderSettingsModal(modal, W, 40)).join('\n');
    expect(atRest).not.toContain(FAKE_PAN);

    // Mid-edit: the in-progress buffer is the window that matters, and it is
    // the one masking at rest alone would leave wide open.
    const idx = modal.currentItems.findIndex((entry) => String(entry.setting.key) === 'payments.cardNumber');
    expect(idx).toBeGreaterThanOrEqual(0);
    while (modal.selectedIndex !== idx) modal.moveDown();
    modal.activateSelected();
    expect(modal.editingMode).toBe(true);
    for (const ch of FAKE_PAN) modal.editChar(ch);

    const midEdit = layerText(renderSettingsModal(modal, W, 40)).join('\n');
    expect(midEdit).not.toContain(FAKE_PAN);
    expect(midEdit).toContain('\u2022'.repeat(FAKE_PAN.length));
  });
});
