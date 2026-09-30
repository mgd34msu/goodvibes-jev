/**
 * The local, pre-judgment privacy boundary. A hosted judgment is itself an
 * outward transmission, even when the eventual tool call would be refused.
 *
 * This does not decide what a command means or try to discover every secret.
 * It refuses declared credential/card fields, known wire operations, literal
 * authentication syntax and the existing deterministic PAN shapes. The owner
 * must enter that material through the secure credential/card UI instead.
 * Ordinary arguments (including paths to secrets and secret references) still
 * need Jev's semantic reading. Nothing here is a substitute or fallback for it.
 *
 * Inspect the complete JSON tree and complete strings BEFORE any reading size
 * cap. Findings and errors carry only a fixed kind, never an argument, path,
 * matched value, length or fingerprint. No secret store or environment is read.
 */
import { findCredentialScopeDeclaration, isDaemonNeededSecretKey } from '../config/credential-scope-registry.js';
import { isSecretBearingConfigKey, isSecretReferenceValue } from '../config/secret-bearing-config-keys.js';
import { CARD_FIELD_NAMES } from '../payments/card-material.js';
import { findCardNumberShapes } from '../security/card-shapes.js';

export type JudgmentInputProblem = 'credential-material' | 'card-material' | 'unsupported-input';

const REASONS: Readonly<Record<JudgmentInputProblem, string>> = {
  'credential-material': 'Refused before judgment: inline credential material must use the secure credential setup path. Pass a stored secret reference instead of a raw value.',
  'card-material': 'Refused before judgment: payment card material must be entered through the local terminal or web UI secure card setup path. Use the stored card id for tool calls.',
  'unsupported-input': 'Refused before judgment: arguments must be bounded plain JSON data without accessors or cycles.',
};

/** A value-free refusal, including when a reading is called without a manager. */
export class JudgmentInputError extends Error {
  constructor(readonly problem: JudgmentInputProblem) {
    super(REASONS[problem]);
    this.name = 'JudgmentInputError';
  }
}

// Explicit wire fields: OAuth token responses, HTTP authentication headers,
// user-auth credentials and provider credentials. Not a suffix/name heuristic.
const CREDENTIAL_FIELDS = new Set([
  'password', 'apiKey', 'api_key', 'clientSecret', 'client_secret',
  'accessToken', 'access_token', 'refreshToken', 'refresh_token', 'id_token',
  'privateKey', 'private_key', 'api-key', 'access-token', 'client-secret', 'private-key',
]);
const AUTH_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie']);
// CardMaterial/CardFieldName and the HTML payment autofill field names.
const CARD_FIELDS = new Set([
  'pan', 'cvv', 'cvc', 'cardNumber', 'cardExpiry', 'cardholderName',
  'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-name',
]);
const CARD_CREATE = 'payments.cards.create';
const CREDENTIAL_SET = 'credentials.set';
const OPERATION_FIELDS = ['method', 'operation', 'tool', 'name'] as const;
const MAX_DEPTH = 64;
const MAX_NODES = 20_000;
const MAX_TEXT_CHARS = 1_000_000;

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

function credentialKey(key: string): boolean {
  return isSecretBearingConfigKey(key) || findCredentialScopeDeclaration(key) !== null || isDaemonNeededSecretKey(key);
}

function declaredControl(selector: unknown): JudgmentInputProblem | undefined {
  if (typeof selector !== 'string') return undefined;
  // CSS attribute equality syntax, not a guess from a merchant's name/label.
  for (const match of selector.matchAll(/\[\s*(autocomplete|type|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*\]/gi)) {
    const attribute = match[1]!.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (attribute === 'type' && value.toLowerCase() === 'password') return 'credential-material';
    if (attribute === 'name' && CARD_FIELDS.has(value)) return 'card-material';
    if (attribute === 'autocomplete' && value.split(/\s+/).some((token) => CARD_FIELDS.has(token))) return 'card-material';
  }
  return undefined;
}

function fieldDeclaration(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = Object.getOwnPropertyDescriptors(value);
  const type: unknown = fields['type']?.value;
  if (typeof type !== 'string' || !['string', 'number', 'integer', 'boolean', 'null'].includes(type)) return false;
  return Object.entries(fields).every(([key, descriptor]) => descriptor.get === undefined && descriptor.set === undefined
    && ['type', 'description', 'title', 'format', 'readOnly', 'writeOnly', '$comment'].includes(key));
}

function protectedKey(key: string): JudgmentInputProblem | undefined {
  if (CARD_FIELDS.has(key)) return 'card-material';
  if (CREDENTIAL_FIELDS.has(key) || AUTH_HEADERS.has(key.toLowerCase()) || credentialKey(key)) return 'credential-material';
  return undefined;
}

function reference(value: unknown): boolean {
  return isSecretReferenceValue(value) && typeof value === 'string' && /^goodvibes:\/\/secrets\/[^\s?#]+$/.test(value.trim());
}

/** A literal assignment/header value can be quoted; references carry no secret. */
function literalValue(text: string): boolean {
  const value = text.trim().replace(/^["']|["']$/g, '');
  return value.length > 0 && !reference(value);
}

/**
 * Read only syntax with a declared meaning: KEY=value / JSON key:value and
 * HTTP authentication headers. Refusing the entire call avoids pretending a
 * redacted shell program has the same effects as the original program.
 */
function inlineProblem(text: string): JudgmentInputProblem | undefined {
  if (findCardNumberShapes(text, 1).length > 0) return 'card-material';
  if (/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(text)) return 'credential-material';
  const assignments = /(?:^|[\s{[,;&?"'])--?([A-Za-z_][A-Za-z0-9_.-]*)\s*(?:=|\s)\s*(?=([^\s,;}]+))/g;
  const fields = /(?:^|[\s{[,;&?"'])([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*[:=]\s*(?=([^\s,;}]+))/g;
  for (const pattern of [assignments, fields]) {
    for (const match of text.matchAll(pattern)) {
      const problem = protectedKey(match[1]!);
      if (problem && literalValue(match[2]!)) return problem;
    }
  }
  // URL userinfo has a password by definition, unlike a word in prose.
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]+/g)) {
    try {
      const url = new URL(match[0]);
      if (url.password.length > 0) return 'credential-material';
      for (const [key, value] of url.searchParams) {
        const problem = protectedKey(key);
        if (problem && present(value) && !reference(value)) return problem;
      }
    } catch { /* Not a URL; its meaning remains Jev's question. */ }
  }
  return undefined;
}

/**
 * Return the first fixed refusal kind. Schema field names and operation names
 * are inspected even in nested tool/params wrappers and JSON-encoded bodies.
 * Empty credential fields and goodvibes secret references carry no raw value.
 */
export function judgmentInputProblem(value: unknown, toolName = ''): JudgmentInputProblem | undefined {
  let nodes = 0;
  let chars = 0;
  const ancestors = new Set<object>();
  function visit(entry: unknown, path: readonly string[], operation: string, depth: number): JudgmentInputProblem | undefined {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return 'unsupported-input';
    if (typeof entry === 'string') {
      chars += entry.length;
      if (chars > MAX_TEXT_CHARS) return 'unsupported-input';
      const trimmed = entry.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        let decoded: unknown;
        try { decoded = JSON.parse(entry); } catch { return inlineProblem(entry); }
        return visit(decoded, path, operation, depth + 1);
      }
      return inlineProblem(entry);
    }
    if (entry === null || entry === undefined || typeof entry === 'boolean') return undefined;
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) return 'unsupported-input';
      return inlineProblem(String(entry));
    }
    if (typeof entry !== 'object' || ancestors.has(entry)) return 'unsupported-input';
    const prototype: unknown = Object.getPrototypeOf(entry);
    if (Array.isArray(entry) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return 'unsupported-input';
    ancestors.add(entry);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(entry);
      if (Object.values(descriptors).some((descriptor) => descriptor.get !== undefined || descriptor.set !== undefined)) return 'unsupported-input';
      const fields: Record<string, unknown> = Object.fromEntries(Object.entries(descriptors)
        .filter(([key, descriptor]) => key !== 'length' && descriptor.enumerable)
        .map(([key, descriptor]) => [key, descriptor.value as unknown]));
      const selected = OPERATION_FIELDS.map((field) => fields[field]).find((field) => field === CARD_CREATE || field === CREDENTIAL_SET);
      const op = typeof selected === 'string' ? selected : operation;
      if (op === CARD_CREATE && CARD_FIELD_NAMES.some((field) => present(fields[field]) && !reference(fields[field]) && !fieldDeclaration(fields[field]))) return 'card-material';
      const typedValue = fields['value'] ?? fields['text'];
      const targetField = fields['field'];
      if (present(typedValue) && !reference(typedValue)) {
        if (typeof targetField === 'string' && (CARD_FIELD_NAMES as readonly string[]).includes(targetField)) return 'card-material';
        const control = declaredControl(fields['selector']);
        if (control) return control;
        if (fields['type'] === 'password') return 'credential-material';
        if (typeof fields['autocomplete'] === 'string' && fields['autocomplete'].split(/\s+/).some((token) => CARD_FIELDS.has(token))) return 'card-material';
      }
      const namedKey = fields['key'] ?? fields['configKey'] ?? fields['secretKey'] ?? fields['name'];
      if (present(fields['value']) && !reference(fields['value']) && !fieldDeclaration(fields['value']) && (op === CREDENTIAL_SET || (typeof namedKey === 'string' && protectedKey(namedKey) !== undefined))) return 'credential-material';
      for (const [key, child] of Object.entries(fields)) {
        const keyProblem = inlineProblem(key);
        if (keyProblem) return keyProblem;
        const fullPath = [...path, key];
        const cardField = (path.at(-1) === 'cardMaterial' && (CARD_FIELD_NAMES as readonly string[]).includes(key)) || (path.at(-1) === 'card' && (key === 'number' || key === 'expiry'));
        const declared = (cardField ? 'card-material' : protectedKey(key)) ?? fullPath.map((_, index) => fullPath.slice(index).join('.')).map(protectedKey).find(Boolean);
        if (declared && present(child) && !reference(child) && !fieldDeclaration(child)) return declared;
        const problem = visit(child, fullPath, op, depth + 1);
        if (problem) return problem;
      }
      return undefined;
    } finally { ancestors.delete(entry); }
  }
  return inlineProblem(toolName) ?? visit(value, [], toolName, 0);
}

/** Must run before accessing the port, not only before awaiting a request. */
export function assertJudgmentInput(value: unknown, toolName = ''): void {
  const problem = judgmentInputProblem(value, toolName);
  if (problem) throw new JudgmentInputError(problem);
}
