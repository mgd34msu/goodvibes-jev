/**
 * daemon-repair-prompt.ts, the interactive half of the one-touch daemon
 * repair: one line at boot, one keypress, and the platform does the rest.
 *
 * The policy, the diagnosis and every effect live in runtime/daemon-repair.ts.
 * This module is only the terminal-facing shape of it: it owns the "waiting for
 * an answer" state, consumes exactly one keystroke, and turns each outcome into
 * a message on the router.
 *
 * It is a self-contained controller rather than another `pendingX` variable
 * threaded through main.ts on purpose. main.ts already carries three of those
 * and sits against the 800-line architecture cap; a controller keeps the state,
 * the wording and the follow-up all in one readable place, and gives the shell
 * a two-method surface (`pending()` / `answer()`) instead of a state field plus
 * two callbacks it would have to thread and reassign.
 */
import { logger, summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import {
  DAEMON_ENABLED_KEY,
  runDaemonRepair,
  type DaemonRepairConfig,
  type DaemonRepairOffer,
  type DaemonRepairResult,
  type DaemonRepairSessionMemory,
} from '../runtime/daemon-repair.ts';
import type { DaemonCliRunner } from '../runtime/daemon-cli-service.ts';

/** The two-method surface the shell's keypress path talks to. */
export interface DaemonRepairPrompt {
  /** True while the offer is on screen awaiting the user's single keypress. */
  readonly pending: () => boolean;
  /**
   * Consume one keystroke. `y` accepts, EVERY other key declines, default no,
   * matching every other boot-time offer in this shell. Returns true when this
   * prompt was the thing waiting, so the caller knows the key was spent.
   */
  readonly answer: (key: string) => boolean;
}

export interface DaemonRepairPromptOptions {
  readonly offer: DaemonRepairOffer;
  readonly config: DaemonRepairConfig;
  readonly session: DaemonRepairSessionMemory;
  readonly systemMessageRouter: { high(message: string): void };
  readonly render: () => void;
  /** Injectable so a test never spawns the real daemon CLI. */
  readonly runDaemonCli?: DaemonCliRunner | undefined;
  /**
   * Injectable repair, so a test drives accept/decline without touching a
   * service manager or a socket. Defaults to the real one.
   */
  readonly repair?: ((offer: DaemonRepairOffer) => Promise<DaemonRepairResult>) | undefined;
}

export function createDaemonRepairPrompt(options: DaemonRepairPromptOptions): DaemonRepairPrompt {
  const { offer, config, session, systemMessageRouter, render } = options;
  let awaitingAnswer = true;

  const repair = options.repair ?? ((pending: DaemonRepairOffer) => runDaemonRepair({
    config,
    offer: pending,
    ...(options.runDaemonCli ? { runDaemonCli: options.runDaemonCli } : {}),
  }));

  return {
    pending: () => awaitingAnswer,
    answer: (key: string) => {
      if (!awaitingAnswer) return false;
      awaitingAnswer = false;
      if (key.toLowerCase().trim() !== 'y') {
        // A decline changes nothing at all, not the setting, not the service,
        // and is remembered for the rest of the session so it is never re-asked.
        session.decline();
        systemMessageRouter.high(`[Daemon] Left as it is, nothing was changed. Set ${DAEMON_ENABLED_KEY} to true in settings whenever you want this machine to reach the platform again.`);
        render();
        return true;
      }

      systemMessageRouter.high(offer.serviceInstalled
        ? '[Daemon] Starting the daemon service and waiting for it to answer...'
        : '[Daemon] Installing and starting the daemon service, then waiting for it to answer...');
      render();

      // Fire-and-forget: this runs inside a keypress handler, and the repair
      // installs or starts a service and then waits for the daemon to answer,
      // far too long to hold the terminal for. Each outcome lands on the router
      // when it happens, and runDaemonRepair never throws, so the catch below
      // exists only so a defect here can never become an unhandled rejection.
      void repair(offer)
        .then((result) => {
          systemMessageRouter.high(result.summary);
          for (const step of result.steps) systemMessageRouter.high(`[Daemon]   - ${step}`);
          render();
        })
        .catch((error: unknown) => {
          logger.error('[daemon-repair] the repair failed unexpectedly', { error: summarizeError(error) });
          systemMessageRouter.high(`[Daemon] The repair did not complete: ${summarizeError(error)}`);
          render();
        });
      return true;
    },
  };
}
