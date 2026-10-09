import { types as nodeTypes } from 'node:util';
import type { CallOptions } from '@goodvibes-jev/judgment';
// ---------------------------------------------------------------------------
// gist-uploader, upload export content to a GitHub Gist
// ---------------------------------------------------------------------------
//
// Architecture: UploadTarget interface with a single GistUploadTarget
// implementation. Future targets (HTTP PUT, Pastebin, etc.) implement
// UploadTarget without changing the caller in share-runtime.
//
// Token resolution:
//   1. serviceRegistry.resolveAuth('github'), standard service registry path
//      (configured via .goodvibes/tui/services.json with tokenKey: GITHUB_TOKEN)
//   2. process.env.GITHUB_TOKEN fallback
//   3. No token → honest guidance; no upload.
//
// Privacy: Gist is created as secret=true (unlisted, not private, anyone with
// the URL can view it).
// ---------------------------------------------------------------------------

import { snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import { readCredentialHeader } from '@goodvibes-jev/engine/sdk/platform/tools';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';

export type UploadResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

/**
 * UploadTarget, interface for pluggable export upload backends.
 * Future HTTP PUT / other targets implement this.
 */
export interface UploadTarget {
  upload(content: string, filename: string): Promise<UploadResult>;
}

export interface GistUploaderOptions {
  /**
   * GitHub PAT with `gist` scope. If not provided the uploader will try
   * process.env.GITHUB_TOKEN then return an error with guidance.
   */
  token?: string;
  /** Description shown on the Gist page. Defaults to filename. */
  description?: string;
}

/** Capture own data properties without invoking getters or retaining mutable input. */
export function captureGithubAuthHeaders(headers: Record<string, string> | null | undefined): Record<string, string> {
  const captured: Record<string, string> = Object.create(null);
  if (!headers) return captured;
  if (nodeTypes.isProxy(headers) || ![Object.prototype, null].includes(Object.getPrototypeOf(headers))
    || Object.getOwnPropertySymbols(headers).length) throw new TypeError('Invalid GitHub auth header');
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(headers))) {
    if (!('value' in descriptor) || typeof descriptor.value !== 'string') throw new TypeError('Invalid GitHub auth header');
    if (!descriptor.enumerable) continue;
    captured[name] = descriptor.value;
  }
  return Object.freeze(captured);
}

/**
 * resolveGithubToken, try auth header map then env var.
 * Returns undefined when no token is available.
 */
export async function resolveGithubToken(
  authHeaders: Record<string, string> | null | undefined,
  options: CallOptions = {},
): Promise<string | undefined> {
  options.signal?.throwIfAborted();
  const captured = captureGithubAuthHeaders(authHeaders);
  const envToken = process.env['GITHUB_TOKEN'];
  if (captured) {
    // Service registry returns { Authorization: 'Bearer <token>' } for bearer type
    const authHeader = captured['Authorization'] ?? captured['authorization'];
    if (authHeader) {
      const match = /^Bearer (.+)$/.exec(authHeader);
      if (match?.[1]) return match[1];
    }
    // Screen every name before any projection or request; values stay local.
    snapshotJudgmentInput(Object.keys(captured));
    // Nonstandard names are read without ever sending their values to judgment.
    for (const [key, val] of Object.entries(captured)) {
      if (!val || key.toLowerCase() === 'authorization') continue;
      if (await readCredentialHeader(key, { ...options, site: 'tui.gist.credential-header' }) === true) return val;
    }
  }
  // Env var fallback
  options.signal?.throwIfAborted();
  return envToken || undefined;
}

/**
 * GistUploadTarget, uploads content to a secret (unlisted) GitHub Gist.
 */
export class GistUploadTarget implements UploadTarget {
  private readonly token: string;
  private readonly description: string;

  constructor(token: string, description?: string) {
    this.token = token;
    this.description = description ?? 'GoodVibes session export';
  }

  async upload(content: string, filename: string, signal?: AbortSignal): Promise<UploadResult> {
    signal?.throwIfAborted();
    const body = JSON.stringify({
      description: this.description,
      public: false, // secret gist: unlisted, not private
      files: {
        [filename]: { content },
      },
    });

    let response: Response;
    try {
      response = await fetch('https://api.github.com/gists', {
        method: 'POST',
        signal,
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body,
      });
    } catch (fetchErr: unknown) {
      const msg = summarizeError(fetchErr);
      return { ok: false, error: `Network error: ${msg}` };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        ok: false,
        error: `GitHub API error ${response.status}: ${text.slice(0, 200)}`,
      };
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return { ok: false, error: 'GitHub API returned non-JSON response' };
    }

    const gistUrl = (json as Record<string, unknown>)['html_url'];
    if (typeof gistUrl !== 'string') {
      return { ok: false, error: 'GitHub API response missing html_url field' };
    }

    return { ok: true, url: gistUrl };
  }
}

/**
 * noTokenGuidance, message printed when no GitHub PAT is found.
 */
export const NO_TOKEN_GUIDANCE = [
  'No GitHub token found for --upload.',
  'To enable Gist upload, configure a GitHub service entry:',
  '  /services import .goodvibes/tui/services.json  (if already configured)',
  'Or set the GITHUB_TOKEN environment variable to a PAT with the `gist` scope.',
  'Token is sent to api.github.com only. Gists are secret (unlisted, not private).',
].join('\n');
