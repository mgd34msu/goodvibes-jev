import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { authoredErrorReadingsPort, errorSpan, errorText } from './authored-error-readings.js';

const alias = 'Knowledge entity aliases are on hold: the required alias readings did not settle within the request budget.';
const activation = 'Knowledge node activation held: no.';
const pdf = 'PDF extraction failed: no readable text was extracted. OCR or a dedicated PDF provider may be required.';

/** Complete synthetic diagnostics only; all other privacy projections remain held. */
export function knowledgeIngestErrorReadings(domain?: JudgmentPort) {
  const errors = authoredErrorReadingsPort({
    fields: { hold: 'other', held: 'other', failed: 'other' },
    parts: [
      [errorText('Knowledge entity aliases are on hold: '), errorSpan('hold'), errorText('')],
      [errorText('Knowledge node activation held: '), errorSpan('held'), errorText('')],
      [errorText('PDF extraction failed: '), errorSpan('failed'), errorText('')],
      [errorText('Synthetic compiler SQL failure')],
      [errorText('Synthetic fetch failed')],
    ],
  }, [
    { message: alias, errorName: 'KnowledgeEntityAliasHoldError', reading: {} },
    { message: activation, errorName: 'KnowledgeNodeActivationHeldError', reading: {} },
    ...[pdf, 'Synthetic compiler SQL failure', 'Synthetic fetch failed'].map(message => ({ message, errorName: 'Error', reading: {} })),
  ]);
  const requests: Parameters<JudgmentPort['ask']>[0][] = [];
  const port: JudgmentPort = {
    model: domain?.model ?? errors.port.model,
    async ask(request) {
      requests.push(request);
      const battery = request.context?.battery;
      if (typeof battery === 'string' && ['engine.redaction.field-kind', 'engine.redaction.credential', 'engine.redaction.residual-credential', 'engine.failure-reading'].includes(battery)) {
        return errors.port.ask(request);
      }
      if (domain) return domain.ask(request);
      throw new Error('No authored ingestion domain reading');
    },
  };
  return { port, requests };
}
