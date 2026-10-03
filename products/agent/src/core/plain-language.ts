/**
 * Plain-language vocabulary gate.
 *
 * Exports the banned-term lists and a validate helper so that the release-gate
 * test and any future caller share a single definition.
 *
 * WHY EACH TERM IS BANNED
 * ───────────────────────
 * FIRST_GLANCE_BANNED, terms the user sees on labels, summaries, and action
 * labels (the copy they read without clicking through). These must never appear
 * in first-glance copy because they are internal implementation vocabulary that
 * a non-technical user would not understand or would find confusing:
 *
 *   WRFC       , internal code-review workflow acronym, never user-facing
 *   daemon     , Unix process jargon; user-facing name is "assistant service"
 *   posture    , internal policy/config term; meaningless to end users
 *   modelRoute , internal routing key; end users pick a "model", not a "route"
 *   agent_harness, raw tool identifier; end users never see tool names
 *   action:"  , raw tool parameter syntax that leaks protocol details
 *   mode:"    , raw tool parameter syntax that leaks protocol details
 *   cli        , developer-facing term; never appears on operator UX labels
 *
 * EVERYWHERE_BANNED, terms that must not appear even in action detail copy
 * (which technical users may read after clicking through):
 *
 *   WRFC       , internal workflow acronym with no end-user meaning
 *   modelRoute , internal routing key never intended for user-facing copy
 */

export const FIRST_GLANCE_BANNED: readonly RegExp[] = [
  /\bWRFC\b/,
  /\bdaemon\b/i,
  /\bposture\b/i,
  /\bmodelRoute\b/,
  /\bagent_harness\b/,
  /action:"/,
  /mode:"/,
  /\bcli\b/i,
];

export const EVERYWHERE_BANNED: readonly RegExp[] = [
  /\bWRFC\b/,
  /\bmodelRoute\b/,
];

/**
 * Return the subset of rules that match `text`.
 * Returns an empty array when there are no violations.
 */
export function validate(text: string, rules: readonly RegExp[]): RegExp[] {
  return rules.filter((rule) => rule.test(text));
}
