import type { VerificationSource } from './types.js';

/** Native message boundaries associate an old instruction with its actual
 * contemporaneous observations. A turn boundary never proves completion. */
export function verificationOriginalTurns(sources: readonly VerificationSource[]): ReadonlyMap<string, readonly VerificationSource[]> {
  const turns = new Map<string, VerificationSource[]>();
  const current = new Map<string, { instructionIndex: string; members: VerificationSource[] }>();
  const result = new Map<string, readonly VerificationSource[]>();
  for (const source of sources) {
    const match = /^(transcript|initial\.transcript|original history before compaction \d+)\[(\d+)\];/u.exec(source.reference);
    if (!match) continue;
    const lane = match[1]!, index = match[2]!;
    let turn = current.get(lane);
    if (source.kind === 'instruction' && source.messageRole === 'user' && turn?.instructionIndex !== index) {
      turn = { instructionIndex: index, members: [] };
      current.set(lane, turn);
      turns.set(`${lane}:${index}`, turn.members);
    }
    if (turn) { turn.members.push(source); result.set(source.id, turn.members); }
  }
  for (const members of turns.values()) Object.freeze(members);
  return result;
}
