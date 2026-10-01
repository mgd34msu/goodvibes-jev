/**
 * Short, human time labels for every view ("5m ago", "in 3d",
 * "Nov 14, 2023"). A missing, zero or pre-2000 time returns '' so no panel ever
 * shows an epoch date; callers drop the label when it is empty.
 */
const MIN_REAL_TIME = 946_684_800_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function shortDate(at: number, now: number): string {
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Date(at).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export function whenLabel(value: number | null | undefined, now: number = Date.now()): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_REAL_TIME) return '';
  const delta = now - value;
  const span = Math.abs(delta);
  const past = delta >= 0;
  if (span < MINUTE) return 'just now';
  if (span < HOUR) {
    const minutes = Math.floor(span / MINUTE);
    return past ? `${minutes}m ago` : `in ${minutes}m`;
  }
  if (span < DAY) {
    const hours = Math.floor(span / HOUR);
    return past ? `${hours}h ago` : `in ${hours}h`;
  }
  if (span < 7 * DAY) {
    const days = Math.floor(span / DAY);
    return past ? `${days}d ago` : `in ${days}d`;
  }
  return shortDate(value, now);
}
