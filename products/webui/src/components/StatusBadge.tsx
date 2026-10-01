import { readWebuiStatusCatalog, type StatusValue } from '@goodvibes-jev/engine/sdk/platform/judgment-browser/catalogs';
import type { BadgeTone } from '../lib/presentation-bridge';
import { Chip } from './ui/Chip';
import type { StatusTone } from './ui/StatusDot';

interface StatusBadgeProps {
  value: string;
  /** Explicit authoritative producer namespace; free text has no inferred tone. */
  catalogId?: string;
  vocabulary?: StatusValue['vocabulary'];
}

const CHIP_TONE: Record<BadgeTone, StatusTone> = {
  ok: 'ok',
  warning: 'warn',
  bad: 'bad',
  neutral: 'idle',
};

/** Authoritative enums use a structural catalog; unread text has no guessed dot. */
export function StatusBadge({ value, catalogId, vocabulary = 'badge' }: StatusBadgeProps) {
  const reading = catalogId === undefined ? undefined : readWebuiStatusCatalog(catalogId, vocabulary);
  if (!reading) return <Chip size="sm" data-classification="unavailable">{value}<span className="lib-quiet"> · unclassified</span></Chip>;
  const tone = reading.vocabulary === 'badge' ? CHIP_TONE[reading.tone] : reading.tone;
  return (
    <Chip size="sm" tone={tone} data-tone={reading.tone} data-classification="structured">
      {value}
    </Chip>
  );
}
