/**
 * A readable label for a config key, for the settings dialog's rows: the key
 * itself still shows beneath in mono, so this only has to read well, never be
 * unique. `provider.systemPromptFile` → "System prompt file";
 * `surfaces.slack.enabled` → "Slack enabled" (a generic last segment borrows
 * the one before it so the row says what it switches).
 */
const ACRONYMS: Readonly<Record<string, string>> = {
  api: 'API',
  cvv: 'CVV',
  dns: 'DNS',
  http: 'HTTP',
  https: 'HTTPS',
  id: 'ID',
  ids: 'IDs',
  ip: 'IP',
  lan: 'LAN',
  llm: 'LLM',
  mb: 'MB',
  ms: 'ms',
  oauth: 'OAuth',
  pct: '%',
  rss: 'RSS',
  sse: 'SSE',
  stt: 'STT',
  tls: 'TLS',
  tts: 'TTS',
  ui: 'UI',
  url: 'URL',
  urls: 'URLs',
  usd: 'USD',
  wrfc: 'WRFC',
};

const GENERIC_LAST = new Set(['enabled', 'enable', 'mode', 'path', 'url', 'model', 'provider', 'key', 'id', 'name', 'port', 'host', 'binary']);

function words(segment: string): string[] {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export function settingLabelForKey(key: string): string {
  const segments = key.split('.').filter(Boolean);
  if (segments.length === 0) return key;
  const last = segments[segments.length - 1];
  const picked = GENERIC_LAST.has(last.toLowerCase()) && segments.length >= 3
    ? [segments[segments.length - 2], last]
    : [last];
  const all = picked.flatMap(words).map((w) => ACRONYMS[w] ?? w);
  if (all.length === 0) return key;
  const [first, ...rest] = all;
  const head = first === first.toLowerCase() ? first.charAt(0).toUpperCase() + first.slice(1) : first;
  return [head, ...rest].join(' ');
}
