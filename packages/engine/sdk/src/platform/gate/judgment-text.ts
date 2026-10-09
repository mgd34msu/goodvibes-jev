import { JudgmentInputError, snapshotJudgmentInput } from './judgment-input.js';

/** Duplicate members must never disappear before structured protection. */
function assertUniqueMembers(json: string): void {
  const objects: (Set<string> | null)[] = [];
  for (const match of json.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]]/g)) {
    const token = match[0];
    if (token === '{') objects.push(new Set());
    else if (token === '[') objects.push(null);
    else if (token === '}' || token === ']') objects.pop();
    else if (json.slice(match.index + token.length).trimStart().startsWith(':')) {
      let key: unknown;
      try { key = JSON.parse(token); } catch { continue; }
      const keys = objects.at(-1);
      if (typeof key !== 'string' || !keys) continue;
      if (keys.has(key)) throw new JudgmentInputError('unsupported-input');
      keys.add(key);
    }
  }
}

/**
 * Protect complete free text, including JSON embedded in prose or encoded in
 * strings. Raw syntax, decoded text AND structured objects are inspected:
 * token-only checks cannot retain relationships such as type/password + value.
 * Nothing is redacted, clipped, summarized or semantically classified here.
 */
export function assertJudgmentText(text: string): void {
  let chars = 0;
  let tokens = 0;
  let scanSteps = 0;
  const unsupported = (): never => { throw new JudgmentInputError('unsupported-input'); };

  // Start at every possible container, not only outside globally quoted prose:
  // an unrelated quote in the surrounding sentence must not hide valid JSON.
  const containerEnd = (value: string, start: number): number | undefined => {
    const stack: string[] = [];
    let quoted = false;
    for (let at = start; at < value.length; at++) {
      if (++scanSteps > 1_000_000) return unsupported();
      const char = value[at]!;
      if (quoted) {
        if (char === '\\') at++;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{' || char === '[') {
        if (stack.length >= 64) return unsupported();
        stack.push(char);
      } else if (char === '}' || char === ']') {
        if (stack.pop() !== (char === '}' ? '{' : '[')) return undefined;
        if (stack.length === 0) return at;
      }
    }
    return undefined;
  };

  const stringEnd = (value: string, start: number): number | undefined => {
    for (let at = start + 1; at < value.length; at++) {
      if (++scanSteps > 1_000_000) return unsupported();
      if (value[at] === '\\') at++;
      else if (value[at] === '"') return at;
    }
    return undefined;
  };

  const inspectParsed = (entry: unknown, depth: number): void => {
    if (depth > 64 || ++tokens > 20_000) return unsupported();
    if (typeof entry === 'string') inspect(entry, depth);
    else if (Array.isArray(entry)) for (const child of entry) inspectParsed(child, depth + 1);
    else if (entry !== null && typeof entry === 'object') {
      for (const [key, child] of Object.entries(entry)) {
        inspect(key, depth + 1);
        inspectParsed(child, depth + 1);
      }
    }
  };

  const inspect = (value: string, depth: number): void => {
    // Bound total decoding/scanning work, not just an individual layer.
    if (depth > 64 || (chars += value.length) > 1_000_000) return unsupported();
    // Force raw inspection before any JSON parse can discard duplicate keys.
    snapshotJudgmentInput({ text: `Judgment evidence:\n${value}` });
    for (let start = 0; start < value.length; start++) {
      if (value[start] !== '{' && value[start] !== '[') continue;
      if (++tokens > 20_000) return unsupported();
      const end = containerEnd(value, start);
      if (end === undefined) continue;
      const json = value.slice(start, end + 1);
      assertUniqueMembers(json);
      let decoded: unknown;
      try { decoded = JSON.parse(json); } catch { continue; }
      // Traverse decoded strings and keys independently of quote alignment
      // in surrounding prose, before the canonical snapshot can parse nested
      // encoded JSON and discard its duplicate members.
      inspectParsed(decoded, depth + 1);
      // The canonical structured boundary retains method/key/value, form
      // controls, nested card fields and all other declared relationships.
      snapshotJudgmentInput(decoded);
      start = end;
    }
    // A free-text quote can also precede a standalone encoded JSON string.
    // Try each quote as a literal start instead of relying on a global regex
    // pairing it with the next quote and thereby skipping the real start.
    for (let start = 0; start < value.length; start++) {
      if (value[start] !== '"') continue;
      if (++tokens > 20_000) return unsupported();
      const end = stringEnd(value, start);
      if (end === undefined) continue;
      let decoded: unknown;
      try { decoded = JSON.parse(value.slice(start, end + 1)); } catch { continue; }
      if (typeof decoded === 'string') inspect(decoded, depth + 1);
    }
    const decodedSyntax = value.replace(/"(?:[^"\\]|\\.)*"/g, (token) => {
      try { return JSON.stringify(JSON.parse(token)); } catch { return token; }
    });
    // Escaped key characters are exposed without discarding any occurrence.
    snapshotJudgmentInput({ text: `Judgment evidence:\n${decodedSyntax}` });
  };
  inspect(text, 0);
}
