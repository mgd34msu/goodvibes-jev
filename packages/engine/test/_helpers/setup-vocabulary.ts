/**
 * The product's own slash commands and config keys, found literally in a
 * setup string.
 *
 * Setup text must never hand the user a command to type or a key to edit
 * (runtime/setup-contract.ts). Whether a reply's wording does that is read by
 * Jev (engine.runtime.setup-reply-command), and the shipped strings that
 * matter are calibrated fixtures of that reading. These tests pin the part
 * that is a fixed vocabulary: a shipped setup string names none of the
 * product's command roots and none of its config keys.
 */
import { CONFIG_KEYS } from '../../sdk/src/platform/config/schema.ts';

/** A character that continues a token: a slash after it is a path, not a command. */
function continuesToken(char: string): boolean {
  return char.length > 0 && /[\w/.:\\-]/.test(char);
}

/** Every command root (like `/google`) and config key `text` names, URLs excluded. */
export function namedCommandsAndKeys(text: string, commandRoots: readonly string[]): readonly string[] {
  const withoutUrls = text.replace(/https?:\/\/\S+/g, ' ');
  const hits: string[] = [];
  for (const root of commandRoots) {
    for (let at = withoutUrls.indexOf(root); at !== -1; at = withoutUrls.indexOf(root, at + root.length)) {
      const before = at === 0 ? '' : withoutUrls[at - 1]!;
      const after = withoutUrls[at + root.length] ?? '';
      if (!continuesToken(before) && (after === '' || !/[-\w./]/.test(after))) hits.push(root);
    }
  }
  for (const key of CONFIG_KEYS) if (withoutUrls.includes(key)) hits.push(key);
  return hits;
}

/** The distinct roots of a list of commands (`/google connect` gives `/google`). */
export function commandRoots(commands: readonly string[]): readonly string[] {
  return [...new Set(commands.map((command) => command.split(' ')[0]!))];
}
