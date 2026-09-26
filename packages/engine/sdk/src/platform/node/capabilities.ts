export type GoodVibesRuntimeSurface =
  | 'client'
  | 'edge'
  | 'mobile'
  | 'node-runtime'
  | 'node-platform';

export type GoodVibesRuntimeRequirement =
  | 'fetch'
  | 'websocket'
  | 'node-like'
  | 'filesystem'
  | 'child-process'
  | 'local-database'
  | 'native-module'
  | 'provider-sdk'
  | 'browser-global'
  | 'secure-mobile-storage';

export interface GoodVibesRuntimeCapability {
  readonly id: string;
  readonly description: string;
  readonly entrypoints: readonly string[];
  readonly surfaces: readonly GoodVibesRuntimeSurface[];
  readonly requirements: readonly GoodVibesRuntimeRequirement[];
  readonly dependencyFamilies: readonly string[];
}

export const GOODVIBES_CLIENT_SAFE_ENTRYPOINTS = [
  '@goodvibes-jev/engine/sdk',
  '@goodvibes-jev/engine/sdk/auth',
  '@goodvibes-jev/engine/sdk/browser',
  '@goodvibes-jev/engine/sdk/browser/homeassistant',
  '@goodvibes-jev/engine/sdk/browser/knowledge',
  '@goodvibes-jev/engine/sdk/client-auth',
  '@goodvibes-jev/engine/sdk/contracts',
  '@goodvibes-jev/engine/sdk/errors',
  '@goodvibes-jev/engine/sdk/events',
  '@goodvibes-jev/engine/sdk/expo',
  '@goodvibes-jev/engine/sdk/observer',
  '@goodvibes-jev/engine/sdk/operator',
  '@goodvibes-jev/engine/sdk/peer',
  '@goodvibes-jev/engine/sdk/react-native',
  '@goodvibes-jev/engine/sdk/transport-core',
  '@goodvibes-jev/engine/sdk/transport-direct',
  '@goodvibes-jev/engine/sdk/transport-http',
  '@goodvibes-jev/engine/sdk/transport-realtime',
  '@goodvibes-jev/engine/sdk/web',
  '@goodvibes-jev/engine/sdk/workers',
] as const;

export const GOODVIBES_NODE_RUNTIME_ENTRYPOINTS = [
  '@goodvibes-jev/engine/sdk/platform/node',
  '@goodvibes-jev/engine/sdk/platform/node/runtime-boundary',
  '@goodvibes-jev/engine/sdk/platform/config',
  '@goodvibes-jev/engine/sdk/platform/core',
  '@goodvibes-jev/engine/sdk/platform/daemon',
  '@goodvibes-jev/engine/sdk/platform/git',
  '@goodvibes-jev/engine/sdk/platform/intelligence',
  '@goodvibes-jev/engine/sdk/platform/integrations',
  '@goodvibes-jev/engine/sdk/platform/knowledge',
  '@goodvibes-jev/engine/sdk/platform/knowledge/extensions',
  '@goodvibes-jev/engine/sdk/platform/knowledge/home-graph',
  '@goodvibes-jev/engine/sdk/platform/multimodal',
  '@goodvibes-jev/engine/sdk/platform/pairing',
  '@goodvibes-jev/engine/sdk/platform/providers',
  '@goodvibes-jev/engine/sdk/platform/runtime',
  '@goodvibes-jev/engine/sdk/platform/runtime/observability',
  '@goodvibes-jev/engine/sdk/platform/runtime/sandbox',
  '@goodvibes-jev/engine/sdk/platform/runtime/settings',
  '@goodvibes-jev/engine/sdk/platform/runtime/state',
  '@goodvibes-jev/engine/sdk/platform/runtime/store',
  '@goodvibes-jev/engine/sdk/platform/runtime/ui',
  '@goodvibes-jev/engine/sdk/contracts/node',
  '@goodvibes-jev/engine/sdk/platform/tools',
  '@goodvibes-jev/engine/sdk/platform/utils',
  '@goodvibes-jev/engine/sdk/platform/voice',
] as const;

export const GOODVIBES_RUNTIME_CAPABILITIES: readonly GoodVibesRuntimeCapability[] = [
  {
    id: 'remote-client',
    description: 'HTTP, realtime, operator, peer, and auth clients for talking to an existing daemon.',
    entrypoints: GOODVIBES_CLIENT_SAFE_ENTRYPOINTS,
    surfaces: ['client', 'edge', 'mobile'],
    requirements: ['fetch', 'websocket'],
    // Display-only patterns, not glob patterns for resolution; document the npm package family.
    dependencyFamilies: [
      '@pellux/goodvibes-transport-*',
      '@goodvibes-jev/engine/operator-sdk',
      '@goodvibes-jev/engine/peer-sdk',
    ],
  },
  {
    id: 'worker-proxy',
    description: 'Cloudflare Worker proxy and queue helpers for forwarding daemon batch work.',
    entrypoints: ['@goodvibes-jev/engine/sdk/workers'],
    surfaces: ['edge'],
    requirements: ['fetch'],
    dependencyFamilies: [],
  },
  {
    id: 'local-runtime',
    description: 'Runtime stores, diagnostics, transports, bootstrap helpers, and explicit local host service subpaths.',
    entrypoints: [
      '@goodvibes-jev/engine/sdk/platform/runtime',
      '@goodvibes-jev/engine/sdk/platform/runtime/observability',
      '@goodvibes-jev/engine/sdk/platform/runtime/sandbox',
      '@goodvibes-jev/engine/sdk/platform/runtime/settings',
      '@goodvibes-jev/engine/sdk/platform/runtime/state',
      '@goodvibes-jev/engine/sdk/platform/runtime/store',
      '@goodvibes-jev/engine/sdk/platform/runtime/ui',
    ],
    surfaces: ['node-runtime', 'node-platform'],
    requirements: ['node-like', 'filesystem', 'local-database'],
    dependencyFamilies: ['sql.js', 'sqlite-vec'],
  },
  {
    id: 'knowledge-system',
    description: 'Knowledge spaces, ingestion, extraction, graph storage, semantic enrichment, generated pages, and extensions.',
    entrypoints: [
      '@goodvibes-jev/engine/sdk/platform/knowledge',
      '@goodvibes-jev/engine/sdk/platform/knowledge/extensions',
      '@goodvibes-jev/engine/sdk/platform/knowledge/home-graph',
    ],
    surfaces: ['node-runtime', 'node-platform'],
    requirements: ['node-like', 'filesystem', 'local-database'],
    dependencyFamilies: [
      'pdfjs-dist',
      'jsdom',
      '@mozilla/readability',
      'jszip',
      'graphql',
      'bplist-parser',
    ],
  },
  {
    id: 'provider-integrations',
    description: 'LLM, voice, multimodal, provider registry, and provider auth integrations.',
    entrypoints: [
      '@goodvibes-jev/engine/sdk/platform/providers',
      '@goodvibes-jev/engine/sdk/platform/voice',
      '@goodvibes-jev/engine/sdk/platform/multimodal',
    ],
    surfaces: ['node-runtime', 'node-platform'],
    requirements: ['node-like', 'provider-sdk'],
    dependencyFamilies: [
      'openai',
      '@anthropic-ai/sdk',
      '@anthropic-ai/bedrock-sdk',
      'google-auth-library',
      'node-edge-tts',
    ],
  },
  {
    id: 'local-tools',
    description: 'Filesystem, shell, git, AST, language-server, and workflow tools used by daemon/TUI runtimes.',
    entrypoints: [
      '@goodvibes-jev/engine/sdk/platform/tools',
      '@goodvibes-jev/engine/sdk/platform/intelligence',
      '@goodvibes-jev/engine/sdk/platform/git',
    ],
    surfaces: ['node-runtime', 'node-platform'],
    requirements: ['node-like', 'filesystem', 'child-process', 'native-module'],
    dependencyFamilies: [
      '@ast-grep/napi',
      'simple-git',
      'web-tree-sitter',
      'tree-sitter-*',
      'bash-language-server',
      'pyright',
      'typescript-language-server',
      'vscode-langservers-extracted',
    ],
  },
] as const;

export function isClientSafeGoodVibesEntrypoint(entrypoint: string): boolean {
  return (GOODVIBES_CLIENT_SAFE_ENTRYPOINTS as readonly string[]).includes(entrypoint);
}

export function isNodeRuntimeGoodVibesEntrypoint(entrypoint: string): boolean {
  return (GOODVIBES_NODE_RUNTIME_ENTRYPOINTS as readonly string[]).includes(entrypoint);
}

export function listGoodVibesRuntimeCapabilities(
  surface?: GoodVibesRuntimeSurface,
): readonly GoodVibesRuntimeCapability[] {
  if (!surface) return GOODVIBES_RUNTIME_CAPABILITIES;
  return GOODVIBES_RUNTIME_CAPABILITIES.filter((capability) => (
    capability.surfaces.includes(surface)
  ));
}
