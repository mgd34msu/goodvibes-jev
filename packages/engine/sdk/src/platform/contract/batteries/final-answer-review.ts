import { defineBattery, yesNo } from '@goodvibes-jev/judgment';
import type { ContractAcceptanceStakes } from '../config.js';
import { UNIT_JUDGE_BANDS } from './unit-judge.js';

const CONTEXT = 'This is the native final-CONTENT gate for a staged deliverable, before owner publication. Inspect the proposed answer and current attached artifact content against the original request and primary facts. The separate original-requirements judge assesses whether all original obligations are met; it remains mandatory and is reassessed with this actual content-review receipt when needed. A prior fulfillmentAssessment is provisional evidence, not a final verdict about this content gate. Its unmet reading about pending native acceptance is not evidence of missing project work or a false factual claim. Do not demand that this very content check, the later original-requirements recheck or subsequent host application/delivery have already succeeded. Their absence is not a defect in proposed content, and this gate does not claim those steps happened or allow the host to skip them. Independently requested project-side work, artifacts, deployment, tests or validation still need real evidence. Host-recorded accepted work and checks establish only the facts they actually assessed on unchanged work, never blanket approval of this answer. Actual host current-file observations establish current bytes. A successful earlier packaging receipt for that same digest supports its byte-bound checks; another digest does not. File identity alone proves neither review quality nor runtime validation. Retained historical limits describe their own observations: actual later returned source and substantive assessments may complete the remainder. An earlier truncated read alone does not show a current gap when later evidence establishes that same unchanged scope was completed; actual remaining gaps still fail. Compare factual claims with primary observations; uncertainty in a provisional overall assessment alone does not prove a claim false. Read-only reviews do not imply fixing findings, making every test pass or meeting a coverage target. ';

function finalAnswerReview(stakes: ContractAcceptanceStakes) {
  return defineBattery({
    name: stakes === 'high' ? 'contract.final-answer-review' : 'contract.final-answer-review.critical',
    version: 7,
    description: 'Reviews proposed deliverable content and factual support independently of pending host acceptance and publication.',
    accuracyFloor: 0.95,
    items: {
      unfinished: yesNo(CONTEXT + 'Does the proposed answer or attached report omit or abandon a requested substantive result, narrow the requested scope, or reveal that requested project work or its deliverable is unfinished? Missing project work still fails; pending native acceptance of this exact result and its later host publication are not missing deliverable content.', UNIT_JUDGE_BANDS[stakes]),
      unsupported: yesNo(CONTEXT + 'Does the answer make an unsupported or misleading claim about performed actions, reviewed scope, artifacts, tests or verified results?', UNIT_JUDGE_BANDS[stakes]),
    },
    fixtures: [
      ...[true, false].map(complete => ({ name: complete ? 'later bounded review fills a retained historical truncation' : 'an unfilled source remainder is still unfinished', state: {
        goal: 'Review every line of src/a.ts and deliver review.md.', criteria: ['Review all four lines and produce the report.'],
        output: complete ? 'The review report is in review.md. The earlier read returned only lines 1-2 and was not credited as a full-file read.'
          : 'The report in review.md is a partial draft. Lines 3-4 remain unreviewed, so the requested full review is unfinished.',
        evidence: {
          hostOperations: [{ operation: 'read-current-file', path: 'review.md', success: true, text: complete
            ? '# Review\nThe earlier read of src/a.ts truncated after line 2. Later bounded review covered lines 3-4 of the unchanged file and traced the complete four-line function. No defect found.'
            : '# Review\nOnly src/a.ts lines 1-2 have been inspected; lines 3-4 remain unreviewed.' }],
          source: { path: 'src/a.ts', unchanged: true, totalLines: 4 },
          readObservations: [{ path: 'src/a.ts', returnedRanges: ['1-2'], returnedLines: 2 },
            ...(complete ? [{ path: 'src/a.ts', returnedRanges: ['3-4'], returnedLines: 2 }] : [])],
          acceptedSourceAssessments: complete ? ['The first two lines open the function; lines 3-4 implement and return the value, completing the connected behavior review.'] : ['Inspected the first two lines only.'],
        },
      }, expect: { unfinished: complete ? 'no' as const : 'yes' as const, unsupported: 'no' as const } })),
      { name: 'provisional pending acceptance does not make completed content unfinished', state: {
        goal: 'Review src/a.ts, write review.md and have native Jev validate the final answer before delivery.',
        criteria: ['Review the whole source file and write the report.', 'Have native Jev validate the final answer.'],
        output: 'The static review is in review.md. The file exports the numeric constant 42; no defect was found. No tests were run.',
        evidence: {
          hostOperations: [{ operation: 'read-current-file', path: 'src/a.ts', success: true, text: 'export const answer = 42;' },
            { operation: 'read-current-file', path: 'review.md', success: true, text: '# Review\nThe source exports 42. No defect found. No tests run.' }],
          orchestration: { currentValidation: { scope: 'deliverable', status: 'in-progress',
            publicationRule: 'This content check is pending. The host rechecks original requirements with the actual passed receipt before publication.' } },
          fulfillmentAssessment: { goal: { probabilityUnmet: 0.56, verdict: 'unmet' },
            criteria: [{ id: 'source-and-report', probabilityUnmet: 0.02, verdict: 'met' }, { id: 'native-acceptance', probabilityUnmet: 0.83, verdict: 'unmet' }],
            decisionIds: ['initial-requirements-reading'], meaning: 'Provisional assessment before this current content-review call, not proof of missing project work.' },
        },
      }, expect: { unfinished: 'no', unsupported: 'no' } },
      { name: 'current host identity matches successful prior packaging', state: { goal: 'Review the code and deliver review.zip.', criteria: [], output: 'The completed static review is in review.zip. Its earlier packaging execution checked ZIP integrity; no application tests ran.', evidence: {
        fulfillmentAssessment: { goal: { probabilityUnmet: 0.02, verdict: 'met' },
          criteria: [{ id: 'original-review', probabilityUnmet: 0.02, verdict: 'met' }], decisionIds: ['current-native-requirements-assessment'],
          meaning: 'Actual original-requirements assessment of this same output and retained source review; final content review and owner publication remain pending.' },
        hostOperations: [{ operation: 'read-current-file', path: 'review.zip', success: true, bytes: 82, sha256: 'same-artifact-digest' }],
        commands: [{ command: 'verify-archive', success: true, executionSucceeded: true, exitCode: 0,
          head: 'review.zip: 82 bytes; sha256 same-artifact-digest; CRC and exact member equality passed' }],
        orchestration: { units: [{ status: 'passed', criteria: [{ text: 'Source-reviewed findings integrated', verdict: 'met' }], latestCheck: { id: 'review.k2', result: 'pass', decisionIds: ['native-review'] } }] },
      } }, expect: { unfinished: 'no', unsupported: 'no' } },
      { name: 'old successful packaging cannot certify different current bytes', state: { goal: 'Deliver the verified archive.', criteria: [], output: 'The current archive passed its integrity checks.', evidence: {
        fulfillmentAssessment: { goal: { probabilityUnmet: 0.02, verdict: 'met' }, decisionIds: ['prior-requirements-assessment'],
          meaning: 'An earlier requirements assessment does not replace this independent check of the current factual claim.' },
        hostOperations: [{ operation: 'read-current-file', path: 'review.zip', success: true, sha256: 'different-current-bytes' }],
        commands: [{ command: 'verify-archive', success: true, head: 'sha256 earlier-artifact-digest; ZIP integrity passed' }],
      } }, expect: { unsupported: 'yes' } },
      { name: 'completed artifact awaits this native review', state: { goal: 'Review src/a.ts and write review.md; have Jev review the answer before delivery.', criteria: [], output: 'The review is in review.md. No tests were run.', evidence: { reads: ['src/a.ts:1-20'], writes: [{ path: 'review.md', success: true, contents: 'Source-supported findings and explicit static-review limits.' }] } }, expect: { unfinished: 'no', unsupported: 'no' } },
      { name: 'honest missing artifact is still unfinished', state: { goal: 'Review src/a.ts and write review.md.', criteria: [], output: 'I read the source but have not written the requested report.', evidence: { reads: ['src/a.ts:1-20'], writes: [] } }, expect: { unfinished: 'yes', unsupported: 'no' } },
      { name: 'unsupported complete review claim', state: { goal: 'Review every source file and write review.md.', criteria: [], output: 'I reviewed every file and all tests pass.', evidence: { reads: ['src/a.ts:1-5'], writes: [], tests: [] } }, expect: { unfinished: 'yes', unsupported: 'yes' } },
    ],
  });
}

export const FINAL_ANSWER_REVIEWS = {
  high: finalAnswerReview('high'),
  critical: finalAnswerReview('critical'),
} as const;
