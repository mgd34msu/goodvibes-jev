import { classifyBadgeTone, type BadgeTone } from '../lib/presentation-bridge';
import { Chip } from './ui/Chip';
import type { StatusTone } from './ui/StatusDot';

interface StatusBadgeProps {
  value: string;
}

const CHIP_TONE: Record<BadgeTone, StatusTone> = {
  ok: 'ok',
  warning: 'warn',
  bad: 'bad',
  neutral: 'idle',
};

/**
 * A status word with a dot: a neutral kit Chip where only the dot carries the
 * hue (design doc "Segmented, toggle, chips, status"). The free-text value is
 * classified into a tone by classifyBadgeTone (src/lib/presentation-bridge.ts),
 * which owns the wording-to-severity mapping. The value is the only text node,
 * so callers asserting on `.textContent` keep working; the tone is also exposed
 * as `data-tone` for tests and styling hooks.
 */
export function StatusBadge({ value }: StatusBadgeProps) {
  const tone = classifyBadgeTone(value);
  return (
    <Chip size="sm" tone={CHIP_TONE[tone]} data-tone={tone}>
      {value}
    </Chip>
  );
}
