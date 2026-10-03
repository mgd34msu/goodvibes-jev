export function localStackFor(value: string): string | null {
  const normalized = value.toLowerCase();
  if (/ollama[-_\s]?cloud/.test(normalized)) return null;
  if (/\bollama\b/.test(normalized)) return 'ollama';
  if (/llama[.-]?cpp|llamacpp/.test(normalized)) return 'llama.cpp';
  if (/\bvllm\b/.test(normalized)) return 'vllm';
  if (/lm[-_\s]?studio/.test(normalized)) return 'openai-compatible';
  if (/localai|text-generation-inference|\btgi\b/.test(normalized)) return 'openai-compatible';
  if (/localhost|127\.0\.0\.1|\[?::1\]?/.test(normalized)) return 'openai-compatible';
  if (/openai-compatible|openai compatible|custom-provider|custom provider/.test(normalized)) return 'openai-compatible';
  return null;
}

export function cleanUrlCandidate(value: string): string {
  return value.trim().replace(/[),.;]+$/g, '');
}

export function extractUrls(value: string): readonly string[] {
  const matches = value.match(/https?:\/\/[^\s"'`<>]+/gi) ?? [];
  return [...new Set(matches.map(cleanUrlCandidate).filter(Boolean))];
}

export function parseUrlCandidate(raw: string): URL | null {
  const trimmed = cleanUrlCandidate(raw);
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

export function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1') return true;
  if (host.endsWith('.local')) return true;
  if (host.includes(':')) return host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:');
  const octets = host.split('.').map((entry) => Number(entry));
  if (octets.length === 4 && octets.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)) {
    const [first, second] = octets as [number, number, number, number];
    return first === 10
      || first === 127
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 169 && second === 254)
      || first === 0;
  }
  return !host.includes('.');
}

export function isPrivateOrLocalUrl(raw: string): boolean {
  const url = parseUrlCandidate(raw);
  if (!url || !/^https?:$/.test(url.protocol)) return false;
  return isPrivateOrLocalHost(url.hostname);
}

export function normalizeLocalBaseUrl(raw: string, stackHint?: string | null): string | null {
  const url = parseUrlCandidate(raw);
  if (!url || !/^https?:$/.test(url.protocol)) return null;
  const stack = stackHint ?? localStackFor(raw) ?? (isPrivateOrLocalHost(url.hostname) ? 'openai-compatible' : null);
  if (!isPrivateOrLocalUrl(url.href)) return null;

  let pathname = url.pathname.replace(/\/+$/g, '');
  if (pathname.endsWith('/models')) pathname = pathname.slice(0, -'/models'.length);
  if (pathname.endsWith('/api/tags')) pathname = pathname.slice(0, -'/api/tags'.length);
  const needsOpenAiPath = stack === 'ollama' || stack === 'llama.cpp' || stack === 'vllm' || stack === 'openai-compatible';
  if (needsOpenAiPath && (!pathname || pathname === '/')) pathname = '/v1';
  url.pathname = pathname || '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/g, '');
}

export function modelsUrlFor(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/g, '')}/models`;
}
