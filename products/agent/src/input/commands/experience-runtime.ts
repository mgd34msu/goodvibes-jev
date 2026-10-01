import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CommandRegistry } from '../command-registry.ts';
import { requireShellPaths, requireVoiceSetup } from './runtime-services.ts';
import { requireYesFlag, stripYesFlag } from './confirmation.ts';
import { handleApprovalOperatorAction } from './operator-actions-runtime.ts';
import { resolveWakeRuntimeSettings } from '@goodvibes-jev/engine/sdk/platform/voice/wake/runtime';
import { agentWakeCapabilities, wakeProvisionReceiptLines, wakeStatusLines, WAKE_SETUP_ANNOUNCEMENT } from '../../core/wake-provision-status.ts';

function formatVoiceComponentState(state: string): string {
  return state.replace(/[_-]+/g, ' ');
}

interface VoiceInstallProgressComponentLike {
  readonly component: string;
  readonly phase: string;
  readonly message?: string | undefined;
  readonly bytesTotal?: number | undefined;
  readonly bytesDone?: number | undefined;
}

interface VoiceInstallProgressLike {
  readonly startedAt: number;
  readonly components: readonly VoiceInstallProgressComponentLike[];
}

/** One honest line per install component: phase plus byte sizes where the manifest knows them. */
function formatVoiceInstallProgressLine(component: VoiceInstallProgressComponentLike): string {
  const mb = (n: number): string => (n / (1024 * 1024)).toFixed(1);
  const bytes = component.bytesTotal !== undefined
    ? (component.bytesDone !== undefined
      ? ` (${mb(component.bytesDone)} of ${mb(component.bytesTotal)} MB)`
      : ` (${mb(component.bytesTotal)} MB)`)
    : '';
  return `  ${component.component}: ${formatVoiceComponentState(component.phase)}${bytes}${component.message ? `, ${component.message}` : ''}`;
}

interface VoiceBundle {
  readonly version: 1;
  readonly exportedAt: number;
  readonly enabled: boolean;
  readonly notes: readonly string[];
}

function inspectVoiceBundle(bundle: VoiceBundle): string {
  return [
    'Voice Review',
    `  exportedAt: ${new Date(bundle.exportedAt).toISOString()}`,
    `  enabled: ${bundle.enabled ? 'yes' : 'no'}`,
    `  notes: ${bundle.notes.length}`,
  ].join('\n');
}

export function registerExperienceRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'approval',
    aliases: ['approvals'],
    description: 'Review action-specific approval classes and the specialized security UX matrix',
    hidden: true,
    usage: '[matrix|review <kind>|approve <id> --yes|deny <id> --yes|cancel <id> --yes]',
    async handler(args, ctx) {
      const sub = (args[0] ?? 'matrix').toLowerCase();
      if (await handleApprovalOperatorAction(args, ctx)) return;
      if (sub === 'open' || sub === 'panel') {
        ctx.print('Open Agent Workspace -> Work & Approvals -> Review approval class for the workspace view, or run /approval matrix for the compact command output.');
        return;
      }
      const matrix = [
        ['shell', 'Shell execution approval with side-effect and credential review.'],
        ['file', 'File mutation approval with config/notebook differentiation.'],
        ['network', 'Network access approval with host/scope review.'],
        ['delegate', 'Explicit GoodVibes TUI build delegation approval; Agent-owned job fanout is blocked.'],
        ['mcp', 'MCP trust escalation approval with host/path review.'],
        ['remote', 'Remote dispatch approval with trust/artifact review.'],
        ['hook', 'Hook execution approval with deny/mutate authority review.'],
        ['plugin', 'Plugin lifecycle approval with provenance and capability review.'],
      ] as const;
      if (sub === 'matrix') {
        ctx.print([
          'Approval Matrix',
          ...matrix.map(([kind, summary]) => `  ${kind.padEnd(10)} ${summary}`),
        ].join('\n'));
        return;
      }
      if (sub === 'review') {
        const kind = (args[1] ?? '').toLowerCase();
        const entry = matrix.find(([id]) => id === kind);
        if (!entry) {
          ctx.print('Usage: /approval review <shell|file|network|delegate|mcp|remote|hook|plugin>');
          return;
        }
        ctx.print([
          `Approval Review: ${entry[0]}`,
          `  ${entry[1]}`,
          '  Related workspaces: /security, /trust, /mcp',
        ].join('\n'));
        return;
      }
      ctx.print('Usage: /approval [matrix|review <kind>|approve <id> --yes|deny <id> --yes|cancel <id> --yes]');
    },
  });

  registry.register({
    name: 'voice',
    description: 'Review voice posture, manage the managed local-voice runtime and the wake-word models, and package portable voice interaction metadata',
    usage: '[review|status|setup --yes|enable --yes|disable --yes|wake status|wake setup --yes|bundle export <path> --yes|bundle inspect <path>]',
    handler(args, ctx) {
      try {
      const parsed = stripYesFlag(args);
      const commandArgs = [...parsed.rest];
      const shellPaths = requireShellPaths(ctx);
      const sub = (commandArgs[0] ?? 'review').toLowerCase();
      if (sub === 'wake') {
        // Wake artifacts live under the same managed voice root as the local
        // runtime, in its `wake` subdirectory, and are served by the same
        // voiceSetup service, so this reads and provisions through the platform's
        // own wake service rather than a second provisioning path. Nothing
        // downloads unless the user typed `setup --yes`.
        const voiceSetup = requireVoiceSetup(ctx);
        const wakeSub = (commandArgs[1] ?? 'status').toLowerCase();
        // Read the artifact state BEFORE resolving: whether the speech gate is on
        // disk decides whether voice.wake.vadThreshold above 0 is honoured or
        // refused, so resolving first would report a blocker that does not match
        // what /voice wake setup has already downloaded.
        const status = voiceSetup.wakeStatus();
        const settings = resolveWakeRuntimeSettings(
          (key: string) => ctx.platform.configManager.get(key as Parameters<typeof ctx.platform.configManager.get>[0]),
          'agent',
          agentWakeCapabilities({ vadReady: status.vadReady }),
        );
        if (wakeSub === 'status') {
          ctx.print(['Wake-Word Detection', ...wakeStatusLines(status, settings)].join('\n'));
          return;
        }
        if (wakeSub === 'setup') {
          if (!parsed.yes) {
            requireYesFlag(ctx, 'download the pinned wake-word classifier and speech-embedding front end (~3.7 MB)', '/voice wake setup --yes');
            return;
          }
          ctx.print(WAKE_SETUP_ANNOUNCEMENT);
          void voiceSetup.wakeProvision()
            .then((result) => { ctx.print(['Wake-Word Setup, receipt', ...wakeProvisionReceiptLines(result)].join('\n')); })
            .catch((error: unknown) => { ctx.print(`Wake-Word Setup\n  provisioning failed: ${error instanceof Error ? error.message : String(error)}`); });
          return;
        }
        ctx.print('Usage: /voice wake [status|setup --yes]');
        return;
      }
      if (sub === 'status') {
        const status = requireVoiceSetup(ctx).status();
        // Live install progress: voice.local.status carries an
        // installInProgress section only while an install run is active
        // (sdk 5357f09e); absent means no run (or an older host build) and
        // nothing renders, never a fabricated progress view.
        const installInProgress: VoiceInstallProgressLike | undefined = status.installInProgress;
        ctx.print([
          'Managed Local-Voice Status',
          `  platform: ${status.platform ?? 'unknown'}`,
          `  state: ${formatVoiceComponentState(status.state)}`,
          `  tts (${status.tts.engine}): binary ${status.tts.binaryPresent ? 'present' : 'missing'}, voice ${status.tts.voicePresent ? 'present' : 'missing'}`,
          `  stt (${status.stt.engine}): ${status.stt.supported ? formatVoiceComponentState(status.stt.state) : 'not supported on this build'}${status.stt.reason ? ` (${status.stt.reason})` : ''}`,
          ...(status.offerBytes != null ? [`  install size ~${Math.round(status.offerBytes / (1024 * 1024))} MB`] : []),
          ...(installInProgress
            ? [
              `  install in progress (started ${new Date(installInProgress.startedAt).toISOString()})`,
              ...installInProgress.components.map((component) => `  ${formatVoiceInstallProgressLine(component)}`),
            ]
            : ['  next /voice setup --yes']),
        ].join('\n'));
        return;
      }
      if (sub === 'setup') {
        if (!parsed.yes) {
          requireYesFlag(ctx, 'install the managed local-voice runtime (downloads piper TTS + a default voice)', '/voice setup --yes');
          return;
        }
        const voiceSetup = requireVoiceSetup(ctx);
        ctx.print('Installing managed local-voice runtime...');
        // Poll voice.local.status while the install call is in flight and
        // render live per-component progress from its installInProgress
        // section (sdk 5357f09e). Honest fallback: a host build whose status
        // never carries the section (an older daemon) just keeps the busy
        // line above until the final receipt, no fabricated progress.
        let installSettled = false;
        const renderedProgress = new Map<string, string>();
        const pollInstallProgress = async (): Promise<void> => {
          while (!installSettled) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            if (installSettled) return;
            try {
              const progress: VoiceInstallProgressLike | undefined = voiceSetup.status().installInProgress;
              if (!progress) continue;
              for (const component of progress.components) {
                const line = formatVoiceInstallProgressLine(component);
                if (renderedProgress.get(component.component) !== line) {
                  renderedProgress.set(component.component, line);
                  ctx.print(line);
                }
              }
            } catch {
              // A failed status read must never break the running install.
            }
          }
        };
        void pollInstallProgress();
        void voiceSetup.install().then((result) => {
          const lines = [
            'Managed Local-Voice Setup',
            ...result.components.map((component) => `  ${component.id}: ${formatVoiceComponentState(component.state)}${component.error ? ` (${component.error})` : ''}`),
            `  tts (${result.tts.engine}): ${formatVoiceComponentState(result.tts.state)}${result.tts.reason ? ` (${result.tts.reason})` : ''}`,
            // STT (whisper.cpp) provisions only where goodvibes has published a
            // pinned per-platform bundle; elsewhere (or before that bundle is
            // published for this platform) it reports its real state honestly
            // rather than a fabricated success.
            `  stt (${result.stt.engine}): ${formatVoiceComponentState(result.stt.state)}${result.stt.reason ? ` (${result.stt.reason})` : ''}`,
            `  result: ${result.provisioned ? 'voice.local.* configured' : 'not provisioned'}`,
            ...result.configured.set.map((entry) => `  set ${entry.key} = ${entry.value}`),
            ...result.configured.skipped.map((entry) => `  skipped ${entry.key} (${entry.reason})`),
          ];
          ctx.print(lines.join('\n'));
        }).catch((error) => {
          ctx.print(`voice setup failed: ${error instanceof Error ? error.message : String(error)}`);
        }).finally(() => {
          installSettled = true;
        });
        return;
      }
      if (sub === 'review') {
        const enabled = Boolean(ctx.platform.configManager.get('ui.voiceEnabled') ?? false);
        ctx.print([
          'Voice Review',
          `  enabled: ${enabled ? 'yes' : 'no'}`,
          '  posture: optional local companion interaction; disabled by default',
          '  note: voice remains an optional operator convenience, not a required SaaS dependency',
          '  next /voice status',
          '  next /voice setup --yes',
        ].join('\n'));
        return;
      }
      if (sub === 'enable' || sub === 'disable') {
        if (!parsed.yes) {
          requireYesFlag(ctx, `${sub} voice interaction`, `/voice ${sub} --yes`);
          return;
        }
        const next = sub === 'enable';
        ctx.platform.configManager.setDynamic('ui.voiceEnabled', next);
        ctx.print(`Voice interaction ${next ? 'enabled' : 'disabled'} for this runtime.`);
        return;
      }
      if (sub === 'bundle') {
        const mode = commandArgs[1];
        const pathArg = commandArgs[2];
        if ((mode === 'export' || mode === 'inspect') && !pathArg) {
          ctx.print(`Usage: /voice bundle ${mode} <path>${mode === 'export' ? ' --yes' : ''}`);
          return;
        }
        const targetPath = shellPaths.resolveWorkspacePath(pathArg!);
        if (mode === 'export') {
          if (!parsed.yes) {
            requireYesFlag(ctx, `export voice bundle to ${pathArg}`, '/voice bundle export <path> --yes');
            return;
          }
          const bundle: VoiceBundle = {
            version: 1,
            exportedAt: Date.now(),
            enabled: Boolean(ctx.platform.configManager.get('ui.voiceEnabled')),
            notes: [
              'Voice is optional and local-first.',
              'Operator review remains the primary review path for risky actions.',
            ],
          };
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf-8');
          ctx.print(`Voice bundle exported to ${targetPath}`);
          return;
        }
        if (mode === 'inspect') {
          if (!existsSync(targetPath)) {
            ctx.print(`File not found: ${targetPath}`);
            return;
          }
          try {
            const bundle = JSON.parse(readFileSync(targetPath, 'utf-8')) as VoiceBundle;
            ctx.print(inspectVoiceBundle(bundle));
          } catch {
            ctx.print('could not read voice bundle');
          }
          return;
        }
      }
      ctx.print('Usage: /voice [review|status|setup --yes|enable --yes|disable --yes|wake status|wake setup --yes|bundle export <path> --yes|bundle inspect <path>]');
      } catch (error) {
        ctx.print(`voice command failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
}
