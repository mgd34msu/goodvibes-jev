import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireShellPaths } from './runtime-services.ts';
import {
  buildSandboxReview,
  getSandboxPreset,
  inspectSandboxBundle,
  inspectSandboxProbe,
  renderSandboxPresets,
  renderSandboxProfiles,
  renderSandboxRecommendation,
  renderSandboxReview,
  type SandboxBundle,
  type SandboxProbe,
} from '@goodvibes-jev/engine/sdk/platform/runtime/sandbox';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { renderSandboxDoctor } from '../../runtime/sandbox-public-gaps.ts';
import { handleSandboxSessionCommand } from './platform-sandbox-session.ts';

const SANDBOX_USAGE = '[open|review|recommend|profiles|presets|preset <id>|apply-preset <id>|probe|doctor|session ...|bundle <export|inspect> <path>|set-mcp <mode>|set-repl <mode>|set-windows <mode>|set-backend local]';
const PRESET_IDS = 'secure-balanced|secure-isolated|shared-performance|windows-basic';

function applySandboxPreset(
  configManager: CommandContext['platform']['configManager'],
  presetId: string,
): boolean {
  const preset = getSandboxPreset(presetId);
  if (!preset) return false;
  configManager.setDynamic('sandbox.replIsolation', preset.config.replIsolation);
  configManager.setDynamic('sandbox.mcpIsolation', preset.config.mcpIsolation);
  configManager.setDynamic('sandbox.windowsMode', preset.config.windowsMode);
  configManager.setDynamic('sandbox.vmBackend', preset.config.vmBackend);
  return true;
}

function renderSandboxPresetDetail(presetId: string): string | null {
  const preset = getSandboxPreset(presetId);
  if (!preset) return null;
  return [
    `Sandbox Preset ${preset.id}`,
    `  label: ${preset.label}`,
    `  summary: ${preset.summary}`,
    `  repl isolation: ${preset.config.replIsolation}`,
    `  mcp isolation: ${preset.config.mcpIsolation}`,
    `  windows mode: ${preset.config.windowsMode}`,
    `  backend: ${preset.config.vmBackend}`,
    '  execution: host-local processes; no VM guest',
    ...preset.notes.map((note) => `  note: ${note}`),
  ].join('\n');
}

export function registerPlatformSandboxRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'sandbox',
    description: 'Review and configure local sandbox policy for MCP and evaluation runtimes',
    usage: SANDBOX_USAGE,
    async handler(args, ctx) {
      const sub = args[0] ?? 'open';
      if (sub === 'open' || sub === 'panel') {
        ctx.openModal?.('sandbox-modal');
        return;
      }
      if (sub === 'review') {
        ctx.print(renderSandboxReview(ctx.platform.configManager));
        return;
      }
      if (sub === 'recommend') {
        ctx.print(renderSandboxRecommendation(ctx.platform.configManager));
        return;
      }
      if (sub === 'profiles') {
        ctx.print(renderSandboxProfiles(ctx.platform.configManager));
        return;
      }
      if (sub === 'presets') {
        ctx.print(renderSandboxPresets());
        return;
      }
      if (sub === 'preset') {
        const rendered = args[1] ? renderSandboxPresetDetail(args[1]) : null;
        ctx.print(rendered ?? `Usage: /sandbox preset <${PRESET_IDS}>`);
        return;
      }
      if (sub === 'apply-preset') {
        const ok = args[1] ? applySandboxPreset(ctx.platform.configManager, args[1]) : false;
        ctx.print(ok ? `Applied sandbox preset ${args[1]}.` : `Usage: /sandbox apply-preset <${PRESET_IDS}>`);
        return;
      }
      if (sub === 'probe') {
        const review = buildSandboxReview(ctx.platform.configManager);
        const probe: SandboxProbe = {
          version: 1,
          checkedAt: Date.now(),
          host: review.host.platform,
          currentBackend: review.backendProbe?.resolvedBackend ?? review.config.vmBackend,
          replIsolation: review.config.replIsolation,
          mcpIsolation: review.config.mcpIsolation,
          windowsMode: review.config.windowsMode,
          secureSandboxReady: review.host.secureSandboxReady,
          recommendedCommand: '/sandbox doctor',
        };
        ctx.print([
          inspectSandboxProbe(probe),
          '  execution: host-local processes; no VM guest',
          ...(review.backendProbe?.warnings ?? []).map((warning) => `  warning: ${warning}`),
          ...review.host.warnings.map((warning) => `  warning: ${warning}`),
        ].join('\n'));
        return;
      }
      if (sub === 'doctor') {
        ctx.print(renderSandboxDoctor(ctx.platform.configManager));
        return;
      }
      // Keep an explicit migration response for old command invocations. No
      // guest provisioning, wrapper execution or retired setting writes remain.
      if (sub === 'qemu' || sub.startsWith('set-qemu-') || ['init-qemu', 'scaffold-qemu-wrapper', 'wrapper-test', 'guest-test', 'guest-bundle'].includes(sub)) {
        ctx.print('QEMU sandbox commands have been retired. This runtime supports the local backend only. Use /sandbox review or /sandbox session.');
        return;
      }
      if (sub === 'bundle') {
        const mode = args[1];
        const pathArg = args[2];
        if (!pathArg || (mode !== 'export' && mode !== 'inspect')) {
          ctx.print('Usage: /sandbox bundle <export|inspect> <path>');
          return;
        }
        const targetPath = requireShellPaths(ctx).resolveWorkspacePath(pathArg);
        try {
          if (mode === 'export') {
            const bundle: SandboxBundle = {
              version: 1,
              exportedAt: Date.now(),
              review: {
                reviewText: renderSandboxReview(ctx.platform.configManager),
                recommendationText: renderSandboxRecommendation(ctx.platform.configManager),
                profilesText: renderSandboxProfiles(ctx.platform.configManager),
              },
            };
            mkdirSync(dirname(targetPath), { recursive: true });
            writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
            ctx.print(`Sandbox bundle exported to ${targetPath}`);
          } else {
            const bundle = JSON.parse(readFileSync(targetPath, 'utf-8')) as SandboxBundle;
            ctx.print(inspectSandboxBundle(bundle));
          }
        } catch (error) {
          ctx.print(`Failed to ${mode} sandbox bundle: ${summarizeError(error)}`);
        }
        return;
      }
      if (sub === 'session') {
        await handleSandboxSessionCommand(args, ctx);
        return;
      }
      if (sub === 'set-mcp') {
        const mode = args[1];
        if (!mode || !['disabled', 'shared-vm', 'hybrid', 'per-server-vm'].includes(mode)) {
          ctx.print('Usage: /sandbox set-mcp <disabled|shared-vm|hybrid|per-server-vm>');
          return;
        }
        ctx.platform.configManager.setDynamic('sandbox.mcpIsolation', mode);
        ctx.print(`Sandbox MCP isolation set to ${mode}.`);
        return;
      }
      if (sub === 'set-repl') {
        const mode = args[1];
        if (!mode || !['shared-vm', 'per-runtime-vm'].includes(mode)) {
          ctx.print('Usage: /sandbox set-repl <shared-vm|per-runtime-vm>');
          return;
        }
        ctx.platform.configManager.setDynamic('sandbox.replIsolation', mode);
        ctx.print(`Sandbox REPL isolation set to ${mode}.`);
        return;
      }
      if (sub === 'set-windows') {
        const mode = args[1];
        if (!mode || !['native-basic', 'require-wsl'].includes(mode)) {
          ctx.print('Usage: /sandbox set-windows <native-basic|require-wsl>');
          return;
        }
        ctx.platform.configManager.setDynamic('sandbox.windowsMode', mode);
        ctx.print(`Sandbox Windows mode set to ${mode}.`);
        return;
      }
      if (sub === 'set-backend') {
        if (args[1] !== 'local') {
          ctx.print('Usage: /sandbox set-backend local (QEMU has been retired)');
          return;
        }
        ctx.platform.configManager.setDynamic('sandbox.vmBackend', 'local');
        ctx.print('Sandbox backend set to local.');
        return;
      }
      ctx.print(`Usage: /sandbox ${SANDBOX_USAGE}`);
    },
  });
}
