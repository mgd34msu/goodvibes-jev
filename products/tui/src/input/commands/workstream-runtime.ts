import { isTerminalContractStatus, type ContractOperatorService, type ContractView } from '@goodvibes-jev/engine/sdk/platform/contract';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';

const USAGE = 'start <request> | list | status <id> | cancel <id> | reply <id> <escalation-id> <answer>';

/** IDs may be abbreviated only when they identify exactly one recorded contract. */
function resolveContract(service: ContractOperatorService, reference: string, sessionId: string): ContractView | null {
  const records = service.list({ sessionId, includeTerminal: true });
  const exact = records.find(record => record.id === reference);
  if (exact) return exact;
  const matches = records.filter(record => record.id.startsWith(reference));
  return matches.length === 1 ? matches[0]! : null;
}

export function renderContractStatus(contract: ContractView): string {
  const lines = [`${contract.id}: ${contract.status}`, contract.ask];
  if (contract.statusLine) lines.push(contract.statusLine);
  if (contract.commit) lines.push(`Changes ${contract.commit.status}: ${contract.commit.note}`);
  for (const group of contract.groups) lines.push(`Group ${group.id}: ${group.status}`);
  for (const unit of contract.units) {
    lines.push(`Unit ${unit.id}: ${unit.status}`);
    for (const criterion of unit.criteria) lines.push(`  ${criterion.id}: ${criterion.text}`);
  }
  for (const escalation of contract.escalations) {
    if (escalation.resolvedAt === undefined) lines.push(`Owner question ${escalation.id}: ${escalation.question}`);
  }
  return lines.join('\n');
}

/** Explicit operator actions use the same runner as conversation intake and the work tree. */
export function registerWorkstreamRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'workstream',
    description: 'Start, inspect, stop, or answer a workstream',
    usage: USAGE,
    argsHint: USAGE,
    handler: async (args, ctx: CommandContext) => {
      const service = ctx.session.contractOperator;
      if (!service) { ctx.print('Workstreams are not available in this session.'); return; }
      const action = args[0] ?? 'list';
      const sessionId = ctx.session.runtime.sessionId;
      try {
        if (action === 'list') {
          const records = service.list({ sessionId, includeTerminal: true });
          ctx.print(records.length ? records.map(record => `${record.id}: ${record.status} — ${record.ask}`).join('\n') : 'No workstreams in this session.');
          return;
        }
        if (action === 'start') {
          const ask = args.slice(1).join(' ').trim();
          if (!ask) { ctx.print('Usage: /workstream start <request>'); return; }
          const result = await service.start({ ask, sessionId });
          ctx.print(renderContractStatus(result.contract));
          ctx.renderRequest();
          return;
        }
        if (action !== 'status' && action !== 'cancel' && action !== 'reply') {
          ctx.print(`Usage: /workstream ${USAGE}`);
          return;
        }
        const reference = args[1];
        const contract = reference ? resolveContract(service, reference, sessionId) : null;
        if (!contract) { ctx.print('Choose one exact or unambiguous workstream ID from /workstream list.'); return; }
        if (action === 'status') { ctx.print(renderContractStatus(contract)); return; }
        if (action === 'cancel') {
          const stopped = service.cancel(contract.id, 'Stopped by the user from /workstream');
          ctx.print(stopped ? `Stopped workstream ${contract.id}.` : `Workstream ${contract.id} has already ended.`);
        } else {
          const escalationId = args[2];
          const answer = args.slice(3).join(' ').trim();
          if (!escalationId || !answer) { ctx.print('Usage: /workstream reply <id> <escalation-id> <answer>'); return; }
          if (isTerminalContractStatus(contract.status) || !contract.escalations.some(entry => entry.id === escalationId && entry.resolvedAt === undefined)) {
            ctx.print('That owner question is no longer open. Inspect /workstream status before answering.');
            return;
          }
          const reply = await service.reply(contract.id, escalationId, answer);
          ctx.print(`Owner reply: ${reply.action}.`);
          const current = service.get(contract.id);
          if (current) ctx.print(renderContractStatus(current));
        }
        ctx.renderRequest();
      } catch (error) {
        ctx.print(`Workstream action failed: ${summarizeError(error)}`);
      }
    },
  });
}
