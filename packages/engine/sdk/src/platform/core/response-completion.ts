import { captureJudgmentPort, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { snapshotJudgmentEvidence } from '../gate/judgment-input.js';
import { captureStrictJudgmentJson, prepareJudgmentResult, retainStrictJudgmentJson } from '../gate/judgment-result.js';
import type { ConversationManager, ConversationMessageSnapshot } from './conversation.js';
import { responseCompletion } from './batteries/response-completion.js';
import { delegationConsolidation } from './batteries/delegation-consolidation.js';
import { executionAssurance } from './batteries/execution-assurance.js';
import type { AgentManager } from '../tools/agent/manager.js';

export class ResponseCompletionError extends Error {
  constructor(readonly problem: 'rejected' | 'unavailable' = 'rejected') {
    super(problem === 'rejected'
      ? 'The assistant repeatedly tried to end with unfinished or unsupported work. The run was stopped without marking it complete.'
      : 'The response completion check could not be established. The run was stopped without marking it complete.');
    this.name = 'ResponseCompletionError';
  }
}

export interface ResponseCompletionInput {
  readonly request: string;
  readonly response: string;
  readonly conversation: ConversationManager;
  readonly tools: readonly string[];
  readonly requirements?: unknown;
  readonly delegated?: readonly { readonly id: string; readonly task: string; readonly status: string; readonly output: string; readonly evidence?: readonly ConversationMessageSnapshot[] }[];
}

function completionTranscript(messages: readonly ConversationMessageSnapshot[]) {
  return messages.map(message => {
    if (message.role === 'user') return { role: message.role, content: typeof message.content === 'string' ? message.content
      : message.content.map(part => part.type === 'text' ? { type: 'text', text: part.text } : { type: 'image', evidence: 'Image content is unavailable to this text check.' }) };
    if (message.role === 'assistant') return { role: message.role, content: message.content, ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}) };
    if (message.role === 'tool') return { role: message.role, content: message.content, callId: message.callId, ...(message.outcome ? { outcome: message.outcome } : {}) };
    return { role: message.role, content: message.content };
  });
}

/** Include only agent IDs actually returned by this conversation's agent tool, never the entire shared fleet. */
export function collectResponseDelegates(conversation: ConversationManager,
  manager: Pick<AgentManager, 'list'> & Partial<Pick<AgentManager, 'getConversationSnapshot'>>): NonNullable<ResponseCompletionInput['delegated']> {
  const messages = conversation.getMessageSnapshot();
  const agentCalls = new Set(messages.flatMap(message => message.role === 'assistant'
    ? (message.toolCalls ?? []).filter(call => call.name === 'agent').map(call => call.id) : []));
  const records = new Map(manager.list().map(record => [record.id, record]));
  const selected = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'tool' || !agentCalls.has(message.callId)) continue;
    let value: unknown;
    try { value = JSON.parse(message.content); } catch { continue; }
    const pending = [value];
    while (pending.length) {
      const entry = pending.pop();
      if (typeof entry === 'string' && records.has(entry)) selected.add(entry);
      else if (entry && typeof entry === 'object') for (const child of Object.values(entry)) pending.push(child);
    }
  }
  return [...selected].map(id => {
    const record = records.get(id)!;
    return { id, task: record.task, status: record.status, output: record.fullOutput ?? '', evidence: manager.getConversationSnapshot?.(id) ?? [] };
  });
}

/** One guard per run. Rejected final drafts return to the model, never to a successful terminal event. */
export class ResponseCompletionGuard {
  private corrections = 0;
  private readonly initial: unknown;
  private accepted: ((response: { readonly content: string }) => (() => void)) | undefined;
  private hasToolEvidence = false;

  constructor(initial?: { readonly request: string; readonly conversation: ConversationManager }) {
    // Keep original words through any compaction inside this run. This is evidence, not new authorization.
    const transcript = initial ? completionTranscript(initial.conversation.getMessageSnapshot()) : [];
    this.initial = initial ? captureStrictJudgmentJson({ request: initial.request, transcript }) : null;
    this.hasToolEvidence = transcript.some(message => message.role === 'tool');
  }

  noteToolResults(results: readonly { readonly success: boolean }[]): void {
    if (results.length) this.hasToolEvidence = true;
    if (results.some(result => result.success)) this.corrections = 0;
  }

  /** Consume the accepted observation before appending its final message; keep its lifetime fence through terminal publication. */
  beginFinalization(response: { readonly content: string }): () => void {
    const accepted = this.accepted;
    this.accepted = undefined;
    if (!accepted) throw new ResponseCompletionError('unavailable');
    try { return accepted(response); }
    catch { throw new ResponseCompletionError('unavailable'); }
  }

  async check(input: ResponseCompletionInput, options: JudgmentReadingOptions = {}): Promise<string | null> {
    this.accepted = undefined;
    try { return await this.read(input, options); }
    catch (error) {
      options.signal?.throwIfAborted(); options.assertCurrent?.();
      if (error instanceof ResponseCompletionError) throw error;
      throw new ResponseCompletionError('unavailable');
    }
  }

  private async read(input: ResponseCompletionInput, options: JudgmentReadingOptions): Promise<string | null> {
    options.signal?.throwIfAborted(); options.assertCurrent?.();
    const conversation = input.conversation, snapshot = conversation.getMessageSnapshot;
    const projectTranscript = () => completionTranscript(snapshot.call(conversation));
    const transcript = projectTranscript();
    // Validate all retained text before touching the port. Never trim away an earlier request or late secret.
    const source = retainStrictJudgmentJson({ request: input.request, response: input.response, transcript,
      tools: input.tools, delegated: (input.delegated ?? []).map(agent => ({ id: agent.id, task: agent.task, status: agent.status,
        output: agent.output, evidence: completionTranscript(agent.evidence ?? []) })), requirements: input.requirements ?? null, initial: this.initial });
    const state = snapshotJudgmentEvidence(source.snapshot);
    const conversationSource = JSON.stringify(transcript);
    const current = () => {
      source.assertCurrent(); options.signal?.throwIfAborted(); options.assertCurrent?.();
      if (input.conversation !== conversation || conversation.getMessageSnapshot !== snapshot
        || input.request !== source.snapshot.request || input.response !== source.snapshot.response
        || JSON.stringify(projectTranscript()) !== conversationSource) throw new Error('Response completion transcript changed.');
    };
    current();
    const owner = captureJudgmentPort(responseCompletion.name, { ...options, assertCurrent: current, prepareResultCapture: prepareJudgmentResult });
    const checks = await Promise.allSettled([
      responseCompletion.run(owner.port, state as never, { site: responseCompletion.name, signal: owner.signal, beforeAttempt: owner.assertCurrent }),
      source.snapshot.delegated.length ? delegationConsolidation.run(owner.port, state as never,
        { site: delegationConsolidation.name, signal: owner.signal, beforeAttempt: owner.assertCurrent }) : Promise.resolve(null),
      this.hasToolEvidence || source.snapshot.transcript.some(message => message.role === 'tool') || source.snapshot.delegated.length
        ? executionAssurance.run(owner.port, state as never,
          { site: executionAssurance.name, signal: owner.signal, beforeAttempt: owner.assertCurrent }) : Promise.resolve(null),
    ]);
    for (const check of checks) if (check.status === 'rejected') throw check.reason;
    const run = (checks[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof responseCompletion.run>>>).value;
    const consolidation = (checks[1] as PromiseFulfilledResult<Awaited<ReturnType<typeof delegationConsolidation.run>> | null>).value;
    const execution = (checks[2] as PromiseFulfilledResult<Awaited<ReturnType<typeof executionAssurance.run>> | null>).value;
    owner.assertCurrent(); current();
    const { false_blocker, unfinished, unsupported, unanswered, unnecessary_permission } = run.readings;
    const executionChecks = execution ? [
      [execution.readings.implementation_presented, execution.readings.ineffective_fix],
      [execution.readings.verification_claimed, execution.readings.irrelevant_verification],
      [execution.readings.criteria_altered, execution.readings.weakened_criteria],
    ] as const : [];
    // Each conditional is settled when either it does not apply or its failure is confidently absent.
    const executionAccepted = executionChecks.every(([applies, failure]) =>
      (applies.verdict === 'no' && applies.outcome === 'act') || (failure.verdict === 'no' && failure.outcome === 'act'));
    if ([false_blocker, unfinished, unsupported, unanswered, unnecessary_permission,
      ...Object.values(consolidation?.readings ?? {})].every(reading => reading.verdict === 'no' && reading.outcome === 'act') && executionAccepted) {
      run.recordAction('Allow the checked final response to end this run.');
      consolidation?.recordAction('Allow the checked synthesis to end this run.');
      execution?.recordAction('Allow completion with relevant execution evidence and unchanged success criteria.');
      owner.assertCurrent(); current();
      this.accepted = response => {
        owner.assertCurrent(); current();
        if (response.content !== source.snapshot.response) throw new ResponseCompletionError('unavailable');
        const restriction = owner.consumeObservation();
        const assertCurrent = () => {
          options.signal?.throwIfAborted(); options.assertCurrent?.();
          try {
            source.assertCurrent(); restriction.assertCurrent();
            if (response.content !== source.snapshot.response) throw new ResponseCompletionError('unavailable');
          } catch { throw new ResponseCompletionError('unavailable'); }
        };
        assertCurrent();
        return assertCurrent;
      };
      return null;
    }
    run.recordAction('Hold completion: continue outstanding authorized work and correct unsupported claims.');
    consolidation?.recordAction('Hold completion until relevant delegated work is incorporated and contradictions are resolved.');
    execution?.recordAction('Hold completion until the fix, verification and success criteria support the requested result.');
    owner.assertCurrent(); current();
    if (this.corrections++ >= 3) throw new ResponseCompletionError();
    return '[Response completion check] This draft has not established that the complete user request is fulfilled and its completion claims are supported. '
      + (false_blocker.verdict === 'yes' ? 'The claimed blocker does not establish that further authorized progress is impossible. ' : '')
      + (unfinished.verdict === 'yes' ? 'The requested work remains unfinished. ' : '')
      + (unsupported.verdict === 'yes' ? 'Claims about completed work lack observed evidence. ' : '')
      + (unanswered.verdict === 'yes' ? 'The user\'s actual question has not been answered. ' : '')
      + (unnecessary_permission.verdict === 'yes' ? 'The response seeks permission for work already authorized. ' : '')
      + (consolidation?.readings.missing_results.verdict === 'yes' ? 'Relevant delegated work has not been incorporated. ' : '')
      + (consolidation?.readings.unresolved_conflict.verdict === 'yes' ? 'Relevant findings conflict and require resolution with evidence. ' : '')
      + (execution?.readings.implementation_presented.verdict === 'yes' && execution.readings.ineffective_fix.verdict === 'yes' ? 'The presented fix leaves the requested behavior broken or hides its symptom. ' : '')
      + (execution?.readings.verification_claimed.verdict === 'yes' && execution.readings.irrelevant_verification.verdict === 'yes' ? 'The observed verification does not establish the behavior claimed. ' : '')
      + (execution?.readings.criteria_altered.verdict === 'yes' && execution.readings.weakened_criteria.verdict === 'yes' ? 'Success criteria were weakened or failures concealed. ' : '')
      + 'Re-read the original request and all later corrections. Continue every still-authorized unfinished requirement using the available tools. '
      + 'Creating a report, narrowing the scope, apologizing, promising to continue, or admitting the work is unfinished does not complete it. '
      + 'Do not ask for permission already granted. If a real external blocker prevents further progress, explain it accurately with evidence. '
      + 'End only after the work is done, the user explicitly stops it, or a necessary user decision or genuine blocker prevents further authorized progress. Do not invent work, results, or test requirements.';
  }
}
