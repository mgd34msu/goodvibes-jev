/**
 * `engine.ecosystem.recommendation-fit`: would installing this uninstalled
 * catalog entry help with the need that triggered a recommendation? Read by
 * Jev in place of the fixed term lists recommendations.ts used to substring
 * match against each entry's id, name, summary, install hint and tags
 * ('provider', 'workflow', 'remote', 'mcp' for plugins; 'review', 'docs',
 * 'refactor', 'workflow' for skills; 'policy', 'approval', 'security',
 * 'sandbox' for policy packs; 'auth', 'mcp', 'oauth', 'service' for hook
 * packs; 'mcp', 'remote', 'service' for MCP-aware plugins).
 *
 * One yes/no per (need, entry) pair, each pair its own request so no entry
 * becomes context for another. The needs are fixed text, one per trigger
 * condition, and live here beside the question so a reviewer reads both in
 * one place. The trigger conditions themselves (installed counts, three or
 * more denials, MCP servers waiting on auth) stay code in recommendations.ts.
 *
 * Band: low stakes. A recommendation only suggests `/marketplace review`;
 * nothing is installed on the strength of it.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';
import type { EcosystemCatalogEntry } from '../catalog.js';

/** Why the project needs something from the catalog, one per trigger condition in recommendations.ts. */
export const RECOMMENDATION_NEEDS = {
  pluginPosture:
    'No plugins are installed in this project yet. It needs a first plugin that connects the agent to an external provider, service or remote tool server, or that automates a development workflow.',
  skillPosture:
    'No skill packs are installed yet. The project needs a skill pack that helps with a common software development workflow, such as code review, documentation or refactoring.',
  policyPosture:
    'The user has denied three or more permission requests. Repeated denials call for a reusable policy pack or a trust-posture change (approval rules, sandboxing, what the agent may do without asking) so the same requests stop being made and refused.',
  mcpAuthHooks:
    'One or more MCP servers are waiting on authentication. The project needs hooks that help authenticate MCP servers or reconnect them, for example by running an OAuth sign-in or refreshing service credentials.',
  mcpAuthPlugins:
    'One or more MCP servers are waiting on authentication. The project needs a plugin that works with MCP or remote services and helps authenticate or reconnect those servers.',
} as const;

export type RecommendationNeed = keyof typeof RECOMMENDATION_NEEDS;

/** What the question sees of an entry: its words, never its source path, signature or version. */
export function recommendationEntryView(entry: EcosystemCatalogEntry): { [field: string]: string | string[] } {
  return {
    kind: entry.kind,
    id: entry.id,
    name: entry.name,
    summary: entry.summary,
    ...(entry.installHint ? { installHint: entry.installHint } : {}),
    tags: [...entry.tags],
  };
}

const entry = (fields: Pick<EcosystemCatalogEntry, 'id' | 'kind' | 'name' | 'summary' | 'tags'> & { installHint?: string }) =>
  recommendationEntryView({ source: 'catalog', ...fields });

const GITHUB_PROVIDER = entry({
  id: 'github-provider',
  kind: 'plugin',
  name: 'GitHub provider',
  summary: 'Adds GitHub issues, pull requests and checks as tools the agent can call.',
  tags: ['provider', 'github', 'integration'],
});
const RELEASE_WORKFLOW = entry({
  id: 'release-workflow',
  kind: 'plugin',
  name: 'Release workflow',
  summary: 'Automates version bumps, changelog generation and tagging for a release.',
  tags: ['workflow', 'release'],
});
const SOLARIZED_THEME = entry({
  id: 'solarized-theme',
  kind: 'plugin',
  name: 'Solarized theme',
  summary: 'Solarized light and dark color schemes for the terminal UI.',
  tags: ['theme', 'ui'],
});
const REMOTE_MCP_BRIDGE = entry({
  id: 'remote-mcp-bridge',
  kind: 'plugin',
  name: 'Remote MCP bridge',
  summary: 'Connects remote MCP servers over HTTP and walks through their OAuth sign-in when a server asks for credentials.',
  tags: ['mcp', 'remote', 'oauth'],
});
const CODE_REVIEW_SKILL = entry({
  id: 'code-review',
  kind: 'skill',
  name: 'Code review',
  summary: 'A review checklist and procedure for reading a diff and reporting defects by severity.',
  tags: ['review', 'quality'],
});
const RECIPE_SKILL = entry({
  id: 'recipe-scaling',
  kind: 'skill',
  name: 'Recipe scaling',
  summary: 'Scales cooking recipes to a different number of servings and converts units.',
  tags: ['cooking'],
});
const STRICT_SHELL_POLICY = entry({
  id: 'shell-approval-rules',
  kind: 'policy-pack',
  name: 'Shell approval rules',
  summary: 'Pre-approves read-only shell commands and asks once per session for writes inside the project, so routine commands stop prompting.',
  tags: ['policy', 'approval', 'shell'],
});
const LICENSE_HEADER_POLICY = entry({
  id: 'license-headers',
  kind: 'policy-pack',
  name: 'License headers',
  summary: 'Checks that every source file starts with the project license header.',
  tags: ['license', 'lint'],
  installHint: 'Set the header text in .goodvibes/license-header.txt after installing.',
});
const MCP_OAUTH_HOOKS = entry({
  id: 'mcp-oauth-refresh',
  kind: 'hook-pack',
  name: 'MCP OAuth refresh',
  summary: 'Hooks that refresh expired OAuth tokens for MCP servers and reconnect them when a server reports auth_required.',
  tags: ['mcp', 'auth', 'oauth'],
});
const FORMAT_ON_SAVE_HOOKS = entry({
  id: 'format-on-save',
  kind: 'hook-pack',
  name: 'Format on save',
  summary: 'Runs the project formatter after every file the agent writes.',
  tags: ['format', 'hooks'],
});

export const recommendationFit = defineBattery({
  name: 'engine.ecosystem.recommendation-fit',
  version: 1,
  description: 'Whether installing an uninstalled ecosystem catalog entry would help with the need that triggered a marketplace recommendation.',
  accuracyFloor: 0.9,
  items: {
    helps: yesNo(
      '`need` says why this project needs something from the ecosystem catalog right now. `entry` is a catalog entry that is not installed. Would installing `entry` help with `need`?',
      STAKES_BANDS.low.yesNo,
      {
        true: "The entry's stated purpose directly addresses the need.",
        false: 'The entry is for something else, or only shares a word or a loose topic with the need.',
      },
    ),
  },
  fixtures: [
    { name: 'provider plugin seeds the plugin posture', state: { need: RECOMMENDATION_NEEDS.pluginPosture, entry: GITHUB_PROVIDER }, expect: { helps: 'yes' } },
    { name: 'workflow plugin seeds the plugin posture', state: { need: RECOMMENDATION_NEEDS.pluginPosture, entry: RELEASE_WORKFLOW }, expect: { helps: 'yes' } },
    { name: 'a color theme does not seed the plugin posture', state: { need: RECOMMENDATION_NEEDS.pluginPosture, entry: SOLARIZED_THEME }, expect: { helps: 'no' } },
    { name: 'code review skill seeds the skill posture', state: { need: RECOMMENDATION_NEEDS.skillPosture, entry: CODE_REVIEW_SKILL }, expect: { helps: 'yes' } },
    { name: 'a cooking skill does not seed the skill posture', state: { need: RECOMMENDATION_NEEDS.skillPosture, entry: RECIPE_SKILL }, expect: { helps: 'no' } },
    { name: 'approval rules answer repeated denials', state: { need: RECOMMENDATION_NEEDS.policyPosture, entry: STRICT_SHELL_POLICY }, expect: { helps: 'yes' } },
    { name: 'a license lint does not answer repeated denials', state: { need: RECOMMENDATION_NEEDS.policyPosture, entry: LICENSE_HEADER_POLICY }, expect: { helps: 'no' } },
    { name: 'OAuth refresh hooks help MCP auth', state: { need: RECOMMENDATION_NEEDS.mcpAuthHooks, entry: MCP_OAUTH_HOOKS }, expect: { helps: 'yes' } },
    { name: 'format hooks do not help MCP auth', state: { need: RECOMMENDATION_NEEDS.mcpAuthHooks, entry: FORMAT_ON_SAVE_HOOKS }, expect: { helps: 'no' } },
    { name: 'a remote MCP bridge helps MCP auth', state: { need: RECOMMENDATION_NEEDS.mcpAuthPlugins, entry: REMOTE_MCP_BRIDGE }, expect: { helps: 'yes' } },
    { name: 'a release workflow does not help MCP auth', state: { need: RECOMMENDATION_NEEDS.mcpAuthPlugins, entry: RELEASE_WORKFLOW }, expect: { helps: 'no' } },
  ],
});
