import { TAGS, current, json, request, type TaggerGuard, type TaggerHttp, type TriageProviderTag } from './shared.js';
export async function applySlackTags(target: { channel: string; timestamp: string }, tags: readonly TriageProviderTag[], token: string, guard: TaggerGuard, http: TaggerHttp = fetch): Promise<void> {
  return applySlackReactions(target, tags.map(tag => TAGS[tag].slack), token, guard, http);
}
/** Prepared exact effect values; custom-name interpretation belongs to the caller owner. */
export async function applySlackReactions(target: { channel: string; timestamp: string }, reactions: readonly string[], token: string, guard: TaggerGuard, http: TaggerHttp = fetch): Promise<void> {
  if (!/^[A-Z0-9]+$/.test(target.channel) || !/^[0-9]+\.[0-9]+$/.test(target.timestamp)) throw new Error('Invalid Slack target');
  if (reactions.some(reaction => !Object.values(TAGS).some(tag => tag.slack === reaction))) throw new Error('Invalid Slack triage reaction');
  for (const name of reactions) {
    const response = await request(http, 'https://slack.com/api/reactions.add', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: target.channel, timestamp: target.timestamp, name }) }, guard);
    const body = await json(response, guard);
    if (body.ok !== true && body.error !== 'already_reacted') throw new Error('Slack triage reaction rejected');
    current(guard);
  }
}
