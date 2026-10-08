/**
 * agent-platform-boundary-policy.ts, a conversational turn does not repair the
 * platform it is running on.
 *
 * ## What happened
 *
 * The owner asked it to sign in to an email account. It could not, worked out
 * why, and announced: "I found the actual defect: the OAuth wizard always
 * forces Branding before consent... I'm repairing that control flow." It had
 * gone into the GoodVibes platform source under his projects directory and
 * started editing. His reply: "I DID NOT SAY TO EDIT MY FUCKING SOURCE CODE",
 * then, immediately after, "I SAID TO LOGIN TO A FUCKING EMAIL ACCOUNT".
 *
 * The mistake is not that it diagnosed something. Diagnosing the platform is
 * WORK, a change to a shipped product, with a review and a release behind it,
 * and this product is conversation-first: work is proposed in one sentence and
 * waits for a yes. A turn that starts it unprompted has substituted its own
 * project for the one he asked for, and the thing he actually wanted is still
 * not done.
 *
 * ## What this guard is, and what it deliberately is not
 *
 * It is NOT a path ban. He did not ask for one, and a blanket refusal to touch
 * those directories would break every legitimate thing he asks for there. The
 * rule is about the FRAMING: platform source touched as a means of self-repair,
 * in a turn where he asked for something else.
 *
 * So the test is his own words this turn. If his message points at the platform
 * source, names a path in it, or names the platform together with a source or
 * a repair word, he asked, and nothing here fires. If his message says nothing
 * about it and the turn reaches for platform source anyway, that is self-
 * directed, and the refusal hands back the sentence to say instead: name the
 * defect in one line, ask whether to look into it, and get back to his actual
 * request.
 *
 * The bias is deliberately toward allowing. A false allow leaves the standing
 * instruction in the operator policy doing the work; a false block breaks
 * something he explicitly asked for, which is the failure he ruled against.
 */

import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { assertAdmittedAgentRead, AGENT_READ_ADMISSION_DENIAL_MESSAGE } from '@goodvibes-jev/engine/sdk/platform/gate/policy';

/**
 * A path segment naming a GoodVibes platform repository.
 *
 * Matches the repo names and their worktrees (`goodvibes-sdk`,
 * `goodvibes-agent-wt-capture`) without matching `.goodvibes`, which is the
 * owner's own state directory and is read constantly for entirely ordinary
 * reasons. The leading dot is what separates them, and it is load-bearing.
 */
const PLATFORM_REPO_SEGMENT = /^goodvibes(?:-[a-z0-9.]+)*$/i;

/** The published platform packages, as they appear inside a node_modules tree. */
const PLATFORM_PACKAGE_SCOPE = '@pellux';
// Closed identities of this workspace's installed packages, not arbitrary
// names that happen to contain the word engine or the scope on its own.
const WORKSPACE_PACKAGE_SCOPE = '@goodvibes-jev';
const WORKSPACE_PLATFORM_PACKAGES = new Set(['engine', 'judgment', 'daemon', 'agent', 'tui', 'webui']);

/** Tools whose arguments carry file paths, and the argument each one carries them in. */
const PATH_BEARING_TOOLS: readonly { readonly name: string; readonly listKey: string }[] = [
  { name: 'read', listKey: 'files' },
  { name: 'write', listKey: 'files' },
  { name: 'edit', listKey: 'edits' },
];

/**
 * Words that mean he is talking about source rather than about the product.
 * "Is the daemon running" is not a request to read the daemon's source; "look
 * at the daemon source" is.
 */
const SOURCE_WORDS = /\b(?:source|sources|sourcecode|repo|repos|repository|repositories|codebase|codebases|file|files|module|package)\b/i;

/**
 * Words that mean he is pointing your attention AT the platform: asking for
 * work on it, or asking you to go and look at it.
 *
 * "Fix the daemon" and "look at the tui" are both requests even though neither
 * names a file, and refusing either would be the opposite mistake. The looking
 * verbs are deliberately included even though they are common words, they only
 * count alongside a platform name, and "show me my calendar" carries none. The
 * bias throughout is toward allowing: the operator policy states the rule in
 * words, and this guard exists to catch the case where he said nothing about
 * the platform at all.
 */
const PLATFORM_ATTENTION_WORDS = /\b(?:fix|fixes|fixing|debug|debugging|patch|patching|repair|repairing|refactor|diagnose|investigate|rewrite|modify|edit|editing|implement|review|read|open|show|look|inspect|examine|check|grep|search)\b/i;

/** Names that mean the GoodVibes platform itself rather than something he owns. */
const PLATFORM_NAME_WORDS = /\b(?:goodvibes|good vibes|pellux|sdk|daemon|tui|webui|web ui|platform)\b/i;

/**
 * The refusal, written as the instruction the model should follow instead.
 *
 * It is a redirect, not a wall: the one-sentence proposal IS the sanctioned
 * route, and naming it here is what keeps a real finding from being swallowed
 * along with the unrequested work.
 */
export const AGENT_PLATFORM_BOUNDARY_DENIAL = [
  'Blocked: this is GoodVibes platform source, and he did not ask you to go into it this turn.',
  'Diagnosing or repairing the platform is work in its own right, it is proposed, not started.',
  'Say in ONE line what looks wrong and ask whether he wants you to look into it, then wait for his answer.',
  'Do not read further into the platform source, do not change it, and do not treat fixing it as a way to finish the thing he actually asked for.',
  'Go back to his actual request and say plainly if it cannot be completed and why.',
].join(' ');

/** True when `path` points inside a GoodVibes platform repository or package. */
export function isGoodVibesPlatformSourcePath(path: string): boolean {
  const segments = path.replaceAll('\\', '/').split('/').filter((segment) => segment.length > 0);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? '';
    if (PLATFORM_REPO_SEGMENT.test(segment)) return true;
    // Retain legacy standalone package identities while admitting only exact
    // canonical workspace identities in an installed node_modules position.
    if (segment.toLowerCase() === WORKSPACE_PACKAGE_SCOPE
      && segments[index - 1]?.toLowerCase() === 'node_modules'
      && WORKSPACE_PLATFORM_PACKAGES.has((segments[index + 1] ?? '').toLowerCase())) return true;
    if (segment.toLowerCase() === PLATFORM_PACKAGE_SCOPE) {
      const next = segments[index + 1] ?? '';
      if (PLATFORM_REPO_SEGMENT.test(next)) return true;
    }
  }
  return false;
}

/**
 * True when his own words this turn point at the platform source.
 *
 * Three ways they can: he named a path in it, he named the platform together
 * with a source word, or he asked for platform work outright.
 */
export function ownerAskedAboutPlatformSource(lastUserMessage: string | null | undefined): boolean {
  const message = typeof lastUserMessage === 'string' ? lastUserMessage.trim() : '';
  if (message.length === 0) return false;
  // A path he typed himself. Split on whitespace and quotes so a path inside a
  // sentence is still seen as a path.
  for (const token of message.split(/[\s"'`,;()[\]{}<>]+/)) {
    if ((token.includes('/') || token.includes('\\')) && isGoodVibesPlatformSourcePath(token)) return true;
  }
  if (!PLATFORM_NAME_WORDS.test(message)) return false;
  return SOURCE_WORDS.test(message) || PLATFORM_ATTENTION_WORDS.test(message);
}

export interface PlatformBoundaryCheckInput {
  /** Every path this tool call would touch. */
  readonly paths: readonly string[];
  /** His message this turn, verbatim. */
  readonly lastUserMessage: string | null | undefined;
}

/**
 * The denial to return, or null to let the call through.
 *
 * Null whenever no path is platform source, and null whenever he asked, in
 * that order, because the cheap check is the one that answers most calls.
 */
export function validatePlatformBoundaryForAgentPolicy(
  input: PlatformBoundaryCheckInput,
): string | null {
  const touchesPlatform = input.paths.some((path) => isGoodVibesPlatformSourcePath(path));
  if (!touchesPlatform) return null;
  if (ownerAskedAboutPlatformSource(input.lastUserMessage)) return null;
  return AGENT_PLATFORM_BOUNDARY_DENIAL;
}

/** Every string `path` under `args[listKey]`, which is an array of records. */
export function readPathsFromToolArgs(args: unknown, listKey: string): readonly string[] {
  if (!isRecord(args)) return [];
  const list = args[listKey];
  if (!Array.isArray(list)) return [];
  const paths: string[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const path = entry.path;
    if (typeof path === 'string' && path.trim().length > 0) paths.push(path);
  }
  return paths;
}

/**
 * Wrap one path-bearing tool so a self-directed platform touch is refused.
 *
 * Wrapped by composition, exactly like every other policy wrapper in this
 * build: the original execute is kept and called on the allow path, so nothing
 * a legitimate call could do is lost.
 */
export function wrapToolForPlatformBoundary(
  tool: Tool,
  listKey: string,
  getLastUserMessage: () => string | null,
): void {
  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args, options) => {
    // The READ path's exact subjects and original host source were read before
    // the common admission. Preserve that scoped decision rather than asking
    // the old name/prose heuristic again after its claim. Write/edit adoption
    // remains separate and retains its current behavior below.
    if (tool.definition.name === 'read') {
      try { assertAdmittedAgentRead(args, options); }
      catch { return { success: false, error: AGENT_READ_ADMISSION_DENIAL_MESSAGE }; }
      return originalExecute(args, options);
    }
    const denial = validatePlatformBoundaryForAgentPolicy({
      paths: readPathsFromToolArgs(args, listKey),
      lastUserMessage: getLastUserMessage(),
    });
    if (denial) return { success: false, error: denial };
    return originalExecute(args, options);
  };
}

/**
 * Install the boundary on every path-bearing tool in `registry`.
 *
 * A tool that is not registered in this build is skipped rather than throwing:
 * the guard is a backstop for a rule the operator policy states in words, and a
 * build without a `write` tool has one fewer way to break it, not a broken
 * install.
 */
export function installAgentPlatformBoundaryGuard(
  registry: ToolRegistry,
  getLastUserMessage: () => string | null,
): void {
  for (const { name, listKey } of PATH_BEARING_TOOLS) {
    const tool = registry.list().find((candidate) => candidate.definition.name === name);
    if (!tool) continue;
    wrapToolForPlatformBoundary(tool, listKey, getLastUserMessage);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
