/**
 * Shared arg-reading/validation helpers for the agent_local_registry tool.
 *
 * Split out of agent-local-registry-tool.ts to stay under the 800-line
 * architecture cap. These are generic across every domain (memory, note,
 * persona, skill, skill_bundle, routine), no domain-specific logic lives
 * here.
 */

export interface AgentLocalRegistryToolArgs {
  readonly domain?: unknown;
  readonly action?: unknown;
  readonly id?: unknown;
  readonly query?: unknown;
  readonly semantic?: unknown;
  readonly cls?: unknown;
  readonly scope?: unknown;
  readonly summary?: unknown;
  readonly detail?: unknown;
  readonly confidence?: unknown;
  readonly title?: unknown;
  readonly name?: unknown;
  readonly description?: unknown;
  readonly body?: unknown;
  readonly sourceUrl?: unknown;
  readonly procedure?: unknown;
  readonly steps?: unknown;
  readonly skills?: unknown;
  readonly skillIds?: unknown;
  readonly requiresEnv?: unknown;
  readonly requiresCommands?: unknown;
  readonly triggers?: unknown;
  readonly tags?: unknown;
  readonly reason?: unknown;
  readonly enabled?: unknown;
  readonly activate?: unknown;
  readonly provenance?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

export const AGENT_TOOL_PROVENANCE = 'agent-local-registry-tool';

export function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function readAffirmative(value: unknown): boolean {
  const normalized = readString(value).toLowerCase();
  return value === true || (typeof value === 'string' && (normalized === '' || normalized === 'yes' || normalized === 'y' || normalized === 'true' || normalized === 'on'));
}

export function readStringList(value: unknown): readonly string[] {
  if (typeof value === 'string') {
    return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean);
}

export function readOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function readOptionalConfidence(value: unknown): number | undefined {
  const confidence = readOptionalNumber(value);
  if (confidence === undefined) return undefined;
  if (confidence < 0 || confidence > 100) throw new Error('confidence must be between 0 and 100.');
  return confidence;
}

export function registryError(message: string): { readonly success: false; readonly error: string } {
  return { success: false, error: message };
}

export function registryOutput(output: string): { readonly success: true; readonly output: string } {
  return { success: true, output };
}

export function requireId(args: AgentLocalRegistryToolArgs): string {
  const id = readString(args.id);
  if (!id) throw new Error('id is required.');
  return id;
}

export function requireConfirmedDelete(args: AgentLocalRegistryToolArgs, label: string): void {
  const explicitUserRequest = readString(args.explicitUserRequest);
  if (!explicitUserRequest) throw new Error(`${label} deletion requires explicitUserRequest with the user's exact request or a short faithful summary.`);
  if (args.confirm !== true) throw new Error(`${label} deletion requires confirm:true after an explicit user request.`);
}

export function requireName(args: AgentLocalRegistryToolArgs): string {
  const name = readString(args.name);
  if (!name) throw new Error('name is required.');
  return name;
}

export function requireDescription(args: AgentLocalRegistryToolArgs): string {
  const description = readString(args.description);
  if (!description) throw new Error('description is required.');
  return description;
}

export function requireTextField(value: unknown, fieldName: string): string {
  const text = readString(value);
  if (!text) throw new Error(`${fieldName} is required.`);
  return text;
}

export function requireSummary(args: AgentLocalRegistryToolArgs): string {
  const summary = readString(args.summary || args.description);
  if (!summary) throw new Error('summary is required.');
  return summary;
}
