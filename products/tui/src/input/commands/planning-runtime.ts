import { directOwnerPlanningInput, type CommandRegistry } from '../command-registry.ts';
import { routeNativeConversationInput } from '../../runtime/native-conversation-ingress.ts';
import { openModalCommand, requirePlanManager } from './runtime-services.ts';
import { togglePlanMode, permissionModeLabel, type PermissionModeValue } from '../../core/permission-mode.ts';
import { parsePlanningActionTarget } from './planning-action-target.ts';

/**
 * Single-token verbs that look like a `/project-plan` subcommand but are not real ones.
 * A lone one of these is refused rather than submitted as a new native goal.
 * Explicit historical `dismiss`, `answer` and `approve` commands are handled
 * separately and never enter native intake.
 */
const PSEUDO_SUBCOMMAND_VERBS = new Set(['pause', 'stop', 'cancel']);

export function registerPlanningRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'project-plan',
    aliases: ['planning'],
    description: 'Submit a native work request, inspect recovery, or review historical planning',
    usage: '[panel | history | approve | dismiss | answer <n> <text> | list | show <id> | mode | explain | override <strategy> | status | clear | <planning goal>]',
    argsHint: '[panel|history|<goal>]',
    async handler(args, ctx) {
      const plannerSubs = ['mode', 'explain', 'override', 'status', 'clear'];
      if (args.length > 0 && plannerSubs.includes(args[0].toLowerCase())) {
        const result = ctx.ops.planRuntime
          ? ctx.ops.planRuntime(args[0], args.slice(1))
          : { ok: false, output: 'Plan runtime bridge is not available in this runtime.' };
        ctx.print(result.output);
        return;
      }

      const projectPlanningService = ctx.workspace.projectPlanningService;
      const projectId = ctx.workspace.projectPlanningProjectId;
      const openProjectPlanningModal = () => openModalCommand(ctx, 'planning-modal');

      if (args.length === 0 || args[0] === 'panel') {
        openModalCommand(ctx, 'native-work-ledger-modal');
        ctx.print('Opened native work and recovery. Saved historical planning is available with /project-plan history.');
        return;
      }

      if (args[0] === 'history') {
        openProjectPlanningModal();
        ctx.print('Opened saved historical project planning. The planning interview is retired; saved answers and approvals do not authorize native work.');
        return;
      }

      if (args[0] === 'approve') {
        if (!projectPlanningService || !projectId) {
          ctx.print('Project planning service is not available in this runtime.');
          return;
        }
        const target = parsePlanningActionTarget(args.slice(1));
        if (!target.valid || target.args.length) {
          ctx.print('Invalid planning selection. Reload saved history before retrying the explicit historical approval command.');
          return;
        }
        const result = await projectPlanningService.applyStateAction({
          projectId, expected: target.expected, ...(target.planningId ? { planningId: target.planningId } : {}), action: { kind: 'approve' },
        });
        if (!result.applied) {
          ctx.print(result.reason === 'no-state' ? 'No historical project planning state exists to approve.' : 'Planning changed. Reload saved history before retrying the explicit historical approval command.');
          return;
        }
        openProjectPlanningModal();
        ctx.print(`Historical planning approval recorded; no native work authorized. State: ${result.state.id}.`);
        return;
      }

      if (args[0] === 'list') {
        const planManager = requirePlanManager(ctx);
        const plans = planManager.list();
        if (plans.length === 0) {
          ctx.print('No plans found.');
          return;
        }
        ctx.print(`Plans (${plans.length}):\n${plans.map((plan) => {
          const marker = plan.status === 'active' ? '▶' : ' ';
          return `  ${marker} ${plan.id.slice(0, 8)}  [${plan.status.padEnd(8)}]  ${plan.title}`;
        }).join('\n')}`);
        return;
      }

      if (args[0] === 'show') {
        const planManager = requirePlanManager(ctx);
        const id = args[1];
        if (!id) {
          ctx.print('Usage: /project-plan show <plan-id>');
          return;
        }
        const plans = planManager.list();
        const plan = plans.find((entry) => entry.id === id || entry.id.startsWith(id));
        if (!plan) {
          ctx.print(`Plan not found: ${id}`);
          return;
        }
        ctx.print(planManager.toMarkdown(plan));
        return;
      }

      // Explicit historical archival only. The current native request and its
      // retained recovery source are untouched; mid-execution is refused.
      if (args[0] === 'dismiss') {
        const planManager = requirePlanManager(ctx);
        const dismissal = planManager.dismiss(ctx.session.runtime.sessionId);
        if (dismissal.outcome === 'requires-cancel') {
          ctx.print(
            `Plan "${dismissal.blockedBy?.title ?? 'active plan'}" is mid-execution and was not dismissed. ` +
            `Run /workstream cancel to stop it first, then /project-plan dismiss.`,
          );
          return;
        }
        let planningNote = '';
        if (projectPlanningService && projectId) {
          const current = await projectPlanningService.getState({ projectId });
          if (current.state && current.state.metadata?.['active'] === true) {
            await projectPlanningService.upsertState({
              projectId,
              state: {
                ...current.state,
                metadata: {
                  ...(current.state.metadata ?? {}),
                  active: false,
                  dismissedAt: Date.now(),
                  dismissedFrom: 'plan-command',
                },
              },
            });
            planningNote = ' Historical project planning record marked inactive.';
          }
        }
        if (dismissal.outcome === 'dismissed') {
          ctx.print(
            `Dismissed plan "${dismissal.plan?.title ?? 'active plan'}" ` +
            `(archived as dismissed; retained in /project-plan list).${planningNote}`,
          );
        } else if (planningNote) {
          ctx.print(`No active execution plan to dismiss.${planningNote}`);
        } else {
          ctx.print('No active plan or planning state to dismiss.');
        }
        return;
      }

      // Explicit historical record editing only. The SDK guards the selected
      // source revision; its evaluation hints never reopen an interview here.
      if (args[0] === 'answer') {
        if (!projectPlanningService || !projectId) {
          ctx.print('Project planning service is not available in this runtime.');
          return;
        }
        const target = parsePlanningActionTarget(args.slice(1));
        if (!target.valid) {
          ctx.print('Invalid planning selection. Reload saved history before retrying the explicit historical answer command.');
          return;
        }
        const ref = target.args[0];
        const answerText = target.args.slice(1).join(' ').trim();
        if (!ref || !answerText) {
          ctx.print('Usage: /project-plan answer <question-number|question-id> <your answer>');
          return;
        }
        const asNum = Number(ref);
        const selector = !target.selected && Number.isInteger(asNum) && asNum >= 1
          ? { questionIndex: asNum - 1 }
          : { questionId: ref };
        const answerResult = await projectPlanningService.applyStateAction({
          projectId, expected: target.expected, ...(target.planningId ? { planningId: target.planningId } : {}),
          action: { kind: 'answer', ...selector, answer: answerText },
        });
        if (!answerResult.applied) {
          if (answerResult.reason === 'no-state') {
            ctx.print('No historical project planning state exists to answer. New goals use native intake with /project-plan <goal>.');
          } else if (answerResult.reason === 'state-changed') {
            ctx.print('Planning changed. Reload saved history before retrying the explicit historical answer command.');
          } else if (answerResult.reason === 'question-not-found') {
            const open = answerResult.state?.openQuestions ?? [];
            const listing = open.length > 0
              ? open.map((question, index) => `  ${index + 1}. ${question.prompt} (${question.id})`).join('\n')
              : '  (no open questions)';
            ctx.print(`No open question matched "${ref}". Open questions:\n${listing}`);
          } else {
            ctx.print('Usage: /project-plan answer <question-number|question-id> <your answer>');
          }
          return;
        }
        openProjectPlanningModal();
        ctx.print(
          `Recorded historical answer to: ${answerResult.question?.prompt ?? 'question'}\n` +
          'The planning interview is retired; no native work authorized.',
        );
        return;
      }

      // Defense (review finding): a single verb-looking token is almost never a
      // real planning goal, it is a mistyped or removed subcommand. The
      // Planning modal used to dispatch `/plan dismiss`, which has no
      // subcommand and silently fell through to this free-form branch, seeding
      // the goal with the literal "dismiss". Refuse to seed on a lone
      // known-or-formerly-planned verb and point at the real usage instead of
      // corrupting the goal.
      if (args.length === 1 && PSEUDO_SUBCOMMAND_VERBS.has(args[0].toLowerCase())) {
        ctx.print(
          `Unknown /project-plan subcommand "${args[0]}": did you mean panel, history, list, show, or status? ` +
          `To submit a new native request, use /project-plan <a real sentence describing the change>.`,
        );
        return;
      }

      const source = directOwnerPlanningInput(ctx);
      if (!source) {
        ctx.print('Submit a new request from the terminal with /project-plan <goal> or /planning <goal>. Original owner input is required.');
        return;
      }
      if (!source.text.trim()) { ctx.print('Usage: /project-plan <goal>'); return; }
      if (!ctx.dispatchNativeIntakeTurn) {
        ctx.print('Native conversation intake is unavailable. No ordinary turn or historical planning state was started.');
        return;
      }
      await routeNativeConversationInput({ intake: ctx.nativeConversationIntake, source,
        notify: line => ctx.print(line), dispatch: ctx.dispatchNativeIntakeTurn });
      ctx.renderRequest();
    },
  });

  // /plan now enters/toggles the SESSION PERMISSION plan mode (read-only
  // planning posture), distinct from the project-planning manager above, which
  // moved to /project-plan (alias /planning). The change goes through the SDK
  // config surface (permissions.mode), the same value the PermissionManager
  // reads and Shift+Tab cycles, so plan mode is one concept across surfaces.
  registry.register({
    name: 'plan',
    description: 'Enter or exit plan mode, a read-only planning posture where writes, commands, and network calls are blocked',
    usage: '[on | off | toggle]',
    argsHint: '[on|off]',
    handler(args, ctx) {
      const configManager = ctx.platform.configManager;
      const current = configManager.get('permissions.mode') as PermissionModeValue | undefined;
      const sub = (args[0] ?? 'toggle').toLowerCase();
      const next: PermissionModeValue =
        sub === 'on' || sub === 'enter' ? 'plan'
        : sub === 'off' || sub === 'exit' ? 'prompt'
        : togglePlanMode(current);
      configManager.set('permissions.mode', next);
      ctx.print(next === 'plan'
        ? '[Permissions] Plan mode ON; read-only: writes, commands, and network calls are blocked until you exit (/plan off or Shift+Tab).'
        : `[Permissions] Plan mode OFF; mode: ${permissionModeLabel(next)}.`);
    },
  });
}
