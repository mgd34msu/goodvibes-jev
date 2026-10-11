import { TAGS, current, json, request, type TaggerGuard, type TaggerHttp, type TriageProviderTag } from './shared.js';

/** Read-only protocol observation. No caller-defined name or raw provider text is a semantic grant. */
export async function observeDiscordForumTags(target: { channel: string; message: string }, token: string, guard: TaggerGuard, http: TaggerHttp = fetch): Promise<readonly string[] | null> {
  if (!/^[0-9]+$/.test(target.channel) || !/^[0-9]+$/.test(target.message)) throw new Error('Invalid Discord target');
  const headers = { Authorization: `Bot ${token}` };
  const thread = await json(await request(http, `https://discord.com/api/v10/channels/${target.channel}`, { headers }, guard), guard);
  if (thread.id !== target.channel) throw new Error('Discord channel identity changed');
  if (thread.type !== 11) return null;
  if (typeof thread.parent_id !== 'string' || !/^[0-9]+$/.test(thread.parent_id)) throw new Error('Discord thread parent unavailable');
  const parent = await json(await request(http, `https://discord.com/api/v10/channels/${thread.parent_id}`, { headers }, guard), guard);
  if (parent.id !== thread.parent_id) throw new Error('Discord parent identity changed');
  if (parent.type !== 15 && parent.type !== 16) return null;
  if (!Array.isArray(thread.applied_tags) || thread.applied_tags.some(id => typeof id !== 'string' || !/^[0-9]+$/.test(id))) throw new Error('Discord observed tags unavailable');
  return Object.freeze([...thread.applied_tags as string[]]);
}

export async function applyDiscordTags(target: { channel: string; message: string }, tags: readonly TriageProviderTag[], token: string, guard: TaggerGuard, forumTagIds: Readonly<Partial<Record<TriageProviderTag, string>>> = {}, http: TaggerHttp = fetch): Promise<void> {
  return applyDiscordTagEffects(target, tags.map(tag => ({ name: tag, reaction: TAGS[tag].discord })), token, guard, forumTagIds, http);
}

/** Exact owner map wins for a verified forum thread; reactions are already interpreted.
 * A forum-only preparation cannot silently fall back after its admitted shape changes. */
export async function applyDiscordTagEffects(target: { channel: string; message: string }, effects: readonly { readonly name: string; readonly reaction?: string }[], token: string, guard: TaggerGuard, forumTagIds: Readonly<Record<string, string | undefined>> = {}, http: TaggerHttp = fetch, requireForum = false): Promise<void> {
  if (!/^[0-9]+$/.test(target.channel) || !/^[0-9]+$/.test(target.message)) throw new Error('Invalid Discord target');
  if (effects.some(effect => effect.reaction !== undefined && !Object.values(TAGS).some(tag => tag.discord === effect.reaction))) throw new Error('Invalid Discord triage reaction');
  const headers = { Authorization: `Bot ${token}` };
  const base = `https://discord.com/api/v10/channels/${target.channel}`;
  const mapped = effects.map(effect => Object.hasOwn(forumTagIds, effect.name) ? forumTagIds[effect.name] : undefined).filter((id): id is string => id !== undefined);
  if (mapped.some(id => !/^[0-9]+$/.test(id))) throw new Error('Invalid Discord forum tag');
  if (mapped.length) {
    const existing = await observeDiscordForumTags(target, token, guard, http);
    if (existing !== null) {
      const applied_tags = [...new Set([...existing, ...mapped])];
      if (applied_tags.length > 5) throw new Error('Discord forum tag limit exceeded');
      const response = await request(http, base, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ applied_tags }) }, guard);
      if (response.status !== 200 && response.status !== 204) throw new Error('Discord forum tag rejected');
      current(guard); return;
    }
  }
  if (requireForum) throw new Error('Discord prepared forum target changed');
  if (effects.some(effect => effect.reaction === undefined)) throw new Error('Discord reaction meaning unavailable');
  for (const effect of effects) {
    const response = await request(http, `${base}/messages/${target.message}/reactions/${encodeURIComponent(effect.reaction!)}/@me`, { method: 'PUT', headers }, guard);
    if (response.status !== 200 && response.status !== 204) throw new Error('Discord triage reaction rejected');
  }
}
