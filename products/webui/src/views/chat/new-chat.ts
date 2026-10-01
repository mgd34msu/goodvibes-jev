/**
 * The new-chat screen's words: the time-of-day greeting and the four starting
 * points. Framework-free so the rules are unit tested (new-chat.test.ts).
 */

/** "Good morning" before noon (from 5), "Good afternoon" until 6 pm, else "Good evening". */
export function greetingPhrase(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/**
 * The name to greet, from the signed-in identity: a display name as given, an
 * email reduced to its local part. '' when there is no real name (the caller
 * then greets without one, never "Good evening, Operator").
 */
export function greetingName(raw: string | undefined | null): string {
  const value = (raw ?? '').trim();
  if (!value) return '';
  const local = value.includes('@') ? value.slice(0, value.indexOf('@')) : value;
  return local.trim();
}

/** "Good evening, Mike" or "Good evening". */
export function greeting(hour: number, name: string): string {
  const phrase = greetingPhrase(hour);
  return name ? `${phrase}, ${name}` : phrase;
}

export type SuggestionIcon = 'calendar' | 'mail' | 'running' | 'memory';

export interface ChatSuggestion {
  id: string;
  icon: SuggestionIcon;
  /** Button text. */
  label: string;
  /** What lands in the composer (not sent: the person reviews and sends). */
  prompt: string;
}

/**
 * Four starting points tied to what GoodVibes actually does: the calendar and
 * mail it reads for you, the sessions and agents it runs, and what it remembers.
 */
export const CHAT_SUGGESTIONS: readonly ChatSuggestion[] = [
  { id: 'calendar', icon: 'calendar', label: "What's on my calendar", prompt: "What's on my calendar today?" },
  { id: 'mail', icon: 'mail', label: 'Check my mail', prompt: 'Check my mail and tell me what needs a reply.' },
  { id: 'running', icon: 'running', label: "What's running", prompt: "What's running right now? Include anything waiting on me." },
  { id: 'memory', icon: 'memory', label: 'What do you remember about…', prompt: 'What do you remember about ' },
];
