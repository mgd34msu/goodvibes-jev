import type { CallOptions, JudgmentPort } from '@goodvibes-jev/judgment';
import { responseFinding } from './batteries/response-finding.js';

/** Quoted text plus a repair instruction, rather than a vague failed boolean. */
export interface CompletionFinding {
  readonly check: string;
  readonly issue: string;
  readonly repair: string;
  readonly resolvedWhen: string;
  readonly passage?: { readonly reference: string; readonly quote: string };
  readonly localization?: 'established' | 'candidate-to-investigate' | 'unavailable';
}

const RESOLVED_WHEN: Readonly<Record<string, string>> = {
  false_blocker: 'The alleged blocker is removed, useful work is completed, or primary evidence establishes a genuine external blocker requiring user input.',
  unfinished: 'The implicated original requirement is fulfilled with relevant observations. Do not add requirements the user did not authorize.',
  unsupported: 'The quoted claim is supported by relevant observations, or corrected or removed while the actual user request remains fulfilled.',
  unanswered: 'The actual question is answered directly and accurately, with the necessary evidence.',
  unnecessary_permission: 'Already-authorized work is completed and no redundant permission request remains.',
  missing_results: 'The relevant delegated result is incorporated, or primary evidence establishes that it is superseded, disproven, duplicated or irrelevant.',
  unresolved_conflict: 'The incompatible claims are resolved with primary evidence and the deliverable reflects that resolution.',
  ineffective_fix: 'The implementation actually satisfies the requested behavior, with verification appropriate to the change.',
  irrelevant_verification: 'The specific verification claim matches observed relevant checks, or the claim is corrected while the requested work remains fulfilled.',
  weakened_criteria: 'The original success criteria remain enforced and the underlying failure is addressed.',
};

export const COMPLETION_ISSUES: Readonly<Record<string, { readonly issue: string; readonly repair: string }>> = {
  false_blocker: { issue: 'The claimed blocker does not establish that useful authorized work is impossible.', repair: 'Inspect the alleged blocker, use an available authorized remedy, and continue the original work.' },
  unfinished: { issue: 'An authorized requirement is unfinished, or the evidence does not establish its completion.', repair: 'Identify the remaining original requirement and perform that work. Changing the summary or documenting reduced scope does not fulfill it.' },
  unsupported: { issue: 'A factual completion or verification claim lacks supporting execution evidence.', repair: 'Obtain the relevant successful tool result or correct the unsupported claim. Do not treat an assistant assertion or a written report as proof that the underlying work happened.' },
  unanswered: { issue: 'The actual user question has not been answered.', repair: 'Answer the question directly using the available evidence; perform the necessary investigation when the answer is not yet known.' },
  unnecessary_permission: { issue: 'The draft asks permission for work already authorized.', repair: 'Perform the authorized work without asking again. Ask only for genuinely missing information or an explicitly required approval.' },
  missing_results: { issue: 'Relevant delegated work has not been incorporated.', repair: 'Retrieve the implicated delegated result, verify its evidence, and incorporate it into the requested deliverable. Recover unfinished delegated work when necessary.' },
  unresolved_conflict: { issue: 'Relevant delegated findings or observed results conflict without resolution.', repair: 'Compare the contradictory source claims and resolve them with relevant observations. Revise the actual deliverable when its conclusions change.' },
  ineffective_fix: { issue: 'The presented implementation leaves the requested failure intact or hides its symptom.', repair: 'Inspect and change the implementation so it satisfies the original behavior; verify the relevant failure without suppressing it.' },
  irrelevant_verification: { issue: 'The observed checks do not establish the specific behavior claimed.', repair: 'Match the exact verification claim to its command, target, scenario and observed result. Run a relevant check if needed, or limit the claim to what was actually verified. A static review does not require unrelated runtime tests or coverage targets.' },
  weakened_criteria: { issue: 'Observed changes weakened success criteria or concealed failures.', repair: 'Restore the original required behavior and meaningful checks, then fix the underlying failure instead of changing the definition of success.' },
};

export function completionFinding(check: string): CompletionFinding {
  return { check, ...COMPLETION_ISSUES[check]!, resolvedWhen: RESOLVED_WHEN[check]! };
}

export async function completionFindings(port: JudgmentPort, evidence: unknown, checks: readonly string[], options: CallOptions): Promise<readonly CompletionFinding[]> {
  const state = evidence as { response: string; request: string; transcript: readonly { role: string; content: unknown }[];
    delegated: readonly { id?: string; output?: string }[] };
  const candidates: { id: string; content: { reference: string; quote: string } }[] = [];
  const add = (reference: string, text: string) => {
    for (const [line, quote] of text.split(/\r?\n/).entries()) if (quote.trim()) {
      candidates.push({ id: `passage-${candidates.length}`, content: { reference: `${reference}, line ${line + 1}`, quote } });
    }
  };
  add('current draft', state.response);
  add('current request', state.request);
  state.transcript.forEach((message, index) => {
    if (message.role === 'user') add(`user request at transcript ${index}`, typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
    if (message.role === 'tool') candidates.push({ id: `passage-${candidates.length}`, content: {
      reference: `tool observation at transcript ${index}`, quote: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    } });
  });
  for (const agent of state.delegated) if (agent.output) add(`delegated result ${agent.id ?? 'unknown'}`, agent.output);
  return Promise.all(checks.map(async check => {
    const description = COMPLETION_ISSUES[check]!;
    const selection = await responseFinding.select(port, { issue: description.issue, evidence } as never, candidates, { ...options, site: responseFinding.name });
    const passage = candidates.find(candidate => candidate.id === selection.pick.choice)?.content;
    const established = selection.outcome === 'act' && selection.chosen !== undefined;
    selection.recordAction(established ? `Return the grounded passage for ${check} to the private revision context.` : `Return ${check} as unresolved, with only a candidate to investigate when one was selected.`);
    return { ...completionFinding(check), localization: passage ? established ? 'established' : 'candidate-to-investigate' : 'unavailable', ...(passage ? { passage } : {}) };
  }));
}
