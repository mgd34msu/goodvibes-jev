import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { AgentPersonaRegistry, assertNoSecretLikeText } from './persona-registry.ts';
import { AgentRoutineRegistry } from './routine-registry.ts';
import { AgentSkillRegistry } from './skill-registry.ts';
import { discoverVibeFiles } from './vibe-file.ts';
import { discoverPersonas, type DiscoveredPersonaRecord } from './persona-discovery.ts';
import { discoverRoutines, type DiscoveredRoutineRecord } from './routine-discovery.ts';
import { discoverSkills, type SkillRecord } from './skill-discovery.ts';
import type { ShellPathService } from '@/runtime/index.ts';
import { STARTER_TEMPLATES, type AgentRuntimeProfileStarterTemplate, type AgentRuntimeProfileStarterTemplateFile } from './runtime-profile-starters.ts';

export type AgentRuntimeProfileTemplateId = string;
export type AgentRuntimeProfileTemplateSource = 'builtin' | 'local';

export interface AgentRuntimeProfileTemplateSummary {
  readonly id: AgentRuntimeProfileTemplateId;
  readonly name: string;
  readonly description: string;
  readonly personaName: string;
  readonly skillNames: readonly string[];
  readonly routineNames: readonly string[];
  readonly vibeIncluded?: boolean;
  readonly source: AgentRuntimeProfileTemplateSource;
  readonly path?: string;
}

export interface AgentRuntimeProfileResolution {
  readonly id: string;
  readonly homeDirectory: string;
}

export interface AgentRuntimeProfileInfo extends AgentRuntimeProfileResolution {
  readonly createdAt: string | null;
  readonly starterTemplateId?: AgentRuntimeProfileTemplateId;
  readonly starterTemplateName?: string;
  readonly starterTemplateApplication?: AgentRuntimeProfileTemplateApplication;
}

export interface AgentRuntimeProfileSelection extends AgentRuntimeProfileResolution {
  readonly selectedAt: string | null;
  readonly path: string;
  readonly exists: boolean;
}

export interface AgentRuntimeProfileTemplateApplication {
  readonly id: AgentRuntimeProfileTemplateId;
  readonly name: string;
  readonly source: AgentRuntimeProfileTemplateSource;
  readonly appliedAt: string;
  readonly personaIds: readonly string[];
  readonly skillIds: readonly string[];
  readonly routineIds: readonly string[];
  readonly vibePath?: string;
}

export interface CreateAgentRuntimeProfileOptions {
  readonly templateId?: AgentRuntimeProfileTemplateId;
}

type AgentRuntimeProfileTemplateShellPaths =
  Pick<ShellPathService, 'homeDirectory' | 'workingDirectory'>
  & Partial<Pick<ShellPathService, 'resolveUserPath' | 'expandHomePath' | 'resolveWorkspacePath'>>;

export interface AgentRuntimeProfileTemplateExportOptions {
  readonly includeVibe?: boolean;
  readonly shellPaths?: AgentRuntimeProfileTemplateShellPaths;
}

export interface CreateAgentRuntimeProfileTemplateFromDiscoveredOptions {
  readonly id: AgentRuntimeProfileTemplateId;
  readonly name?: string;
  readonly description?: string;
  readonly persona?: string;
  readonly skills?: readonly string[];
  readonly routines?: readonly string[];
  readonly includeVibe?: boolean;
  readonly replace?: boolean;
}

export interface CreateAgentRuntimeProfileFromDiscoveredOptions extends Omit<CreateAgentRuntimeProfileTemplateFromDiscoveredOptions, 'id'> {
  readonly profileName: string;
  readonly templateId?: AgentRuntimeProfileTemplateId;
}

export interface AgentRuntimeProfileCommandResult {
  readonly ok: boolean;
  readonly kind:
    | 'agent.profiles.list'
    | 'agent.profiles.show'
    | 'agent.profiles.templates'
    | 'agent.profiles.template.export'
    | 'agent.profiles.template.import'
    | 'agent.profiles.template.from_discovered'
    | 'agent.profiles.create_from_discovered'
    | 'agent.profiles.create'
    | 'agent.profiles.default'
    | 'agent.profiles.default.clear'
    | 'agent.profiles.delete'
    | 'agent.profiles.error';
  readonly data?: {
    readonly profiles?: readonly AgentRuntimeProfileInfo[];
    readonly profile?: AgentRuntimeProfileInfo;
    readonly selectedProfile?: AgentRuntimeProfileSelection;
    readonly templates?: readonly AgentRuntimeProfileTemplateSummary[];
    readonly appliedTemplate?: AgentRuntimeProfileTemplateApplication;
    readonly template?: AgentRuntimeProfileTemplateSummary;
    readonly path?: string;
    readonly nextCommand?: string;
  };
  readonly error?: string;
}

const PROFILE_CREATED_FILE = 'profile.json';
const PROFILE_SELECTION_FILE = 'profile-selection.json';
const PROFILE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeAgentRuntimeProfileId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .replace(/[-_]{2,}/g, '-');
}

export function assertValidAgentRuntimeProfileId(value: string): string {
  const raw = value.trim();
  if (raw.includes('..') || raw.includes('/') || raw.includes('\\')) {
    throw new Error('Agent profile names cannot contain path traversal sequences.');
  }
  const normalized = normalizeAgentRuntimeProfileId(value);
  if (!PROFILE_ID_PATTERN.test(normalized)) {
    throw new Error('Agent profile names must normalize to 1-64 lowercase letters, numbers, dots, underscores, or dashes.');
  }
  return normalized;
}

export function getAgentRuntimeProfilesRoot(baseHomeDirectory: string): string {
  return join(baseHomeDirectory, '.goodvibes', 'agent', 'profile-homes');
}

export function getAgentRuntimeProfileTemplatesRoot(baseHomeDirectory: string): string {
  return join(baseHomeDirectory, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, 'profile-starters');
}

export function getAgentRuntimeProfileSelectionPath(baseHomeDirectory: string): string {
  return join(baseHomeDirectory, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, PROFILE_SELECTION_FILE);
}

export function resolveAgentRuntimeProfileHome(baseHomeDirectory: string, profileName: string): AgentRuntimeProfileResolution {
  const id = assertValidAgentRuntimeProfileId(profileName);
  return {
    id,
    homeDirectory: join(getAgentRuntimeProfilesRoot(baseHomeDirectory), id),
  };
}

export function readAgentRuntimeProfileSelection(baseHomeDirectory: string): AgentRuntimeProfileSelection | null {
  const path = getAgentRuntimeProfileSelectionPath(baseHomeDirectory);
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!isRecord(raw)) return null;
    const profileId = raw.profileId;
    if (typeof profileId !== 'string') return null;
    const resolution = resolveAgentRuntimeProfileHome(baseHomeDirectory, profileId);
    const selectedAt = typeof raw.selectedAt === 'string' ? raw.selectedAt : null;
    return {
      ...resolution,
      selectedAt,
      path,
      exists: existsSync(resolution.homeDirectory),
    };
  } catch {
    return null;
  }
}

export function resolveSelectedAgentRuntimeProfileHome(baseHomeDirectory: string): AgentRuntimeProfileResolution | null {
  const selection = readAgentRuntimeProfileSelection(baseHomeDirectory);
  if (!selection?.exists) return null;
  return {
    id: selection.id,
    homeDirectory: selection.homeDirectory,
  };
}

function readProfileCreatedAt(homeDirectory: string): string | null {
  const path = join(homeDirectory, PROFILE_CREATED_FILE);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    if (raw && typeof raw === 'object' && typeof raw.createdAt === 'string') return raw.createdAt;
  } catch {
    return null;
  }
  return null;
}

function readProfileStarterTemplate(homeDirectory: string): Pick<AgentRuntimeProfileInfo, 'starterTemplateId' | 'starterTemplateName'> {
  const path = join(homeDirectory, PROFILE_CREATED_FILE);
  if (!existsSync(path)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!isRecord(raw)) return {};
    const starter = raw.starterTemplate;
    if (!isRecord(starter)) return {};
    const id = starter.id;
    const name = starter.name;
    if (!isAgentRuntimeProfileTemplateId(id) || typeof name !== 'string') return {};
    return {
      starterTemplateId: id,
      starterTemplateName: name,
    };
  } catch {
    return {};
  }
}

function buildProfileInfo(baseHomeDirectory: string, id: string): AgentRuntimeProfileInfo {
  const { homeDirectory } = resolveAgentRuntimeProfileHome(baseHomeDirectory, id);
  return {
    id,
    homeDirectory,
    createdAt: readProfileCreatedAt(homeDirectory),
    ...readProfileStarterTemplate(homeDirectory),
  };
}

function profileStorePath(homeDirectory: string, folder: string, file: string): string {
  return join(homeDirectory, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, folder, file);
}

export function isAgentRuntimeProfileTemplateId(value: unknown): value is AgentRuntimeProfileTemplateId {
  if (typeof value !== 'string') return false;
  try {
    assertValidAgentRuntimeProfileId(value);
    return true;
  } catch {
    return false;
  }
}

function summarizeTemplate(template: AgentRuntimeProfileStarterTemplate): AgentRuntimeProfileTemplateSummary {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    personaName: template.personaName,
    skillNames: [...template.skillNames],
    routineNames: [...template.routineNames],
    vibeIncluded: Boolean(template.vibe?.body.trim()),
    source: template.source,
    path: template.path,
  };
}

function parseStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean);
}

function splitFrontmatterList(value: string | undefined): readonly string[] {
  if (!value) return [];
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function normalizedLookupValues(value: string, path?: string): readonly string[] {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const basename = path?.split(/[\\/]/).pop()?.replace(/\.md$/i, '') ?? '';
  return [value, slug, path ?? '', basename].map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

function selectDiscoveredRecord<T extends { readonly name: string; readonly path: string }>(
  records: readonly T[],
  selector: string | undefined,
  label: string,
): T {
  if (records.length === 0) throw new Error(`No discovered Agent ${label} files found.`);
  if (!selector?.trim()) return records[0]!;
  const lookup = selector.trim().toLowerCase();
  const match = records.find((record) => normalizedLookupValues(record.name, record.path).includes(lookup));
  if (!match) throw new Error(`Unknown discovered Agent ${label} ${selector}.`);
  return match;
}

function selectDiscoveredRecords<T extends { readonly name: string; readonly path: string }>(
  records: readonly T[],
  selectors: readonly string[] | undefined,
  label: string,
): readonly T[] {
  if (records.length === 0) throw new Error(`No discovered Agent ${label} files found.`);
  if (!selectors || selectors.length === 0 || selectors.includes('all')) return records;
  return selectors.map((selector) => selectDiscoveredRecord(records, selector, label));
}

function discoveredSkillToTemplate(skill: SkillRecord): AgentRuntimeProfileStarterTemplate['skills'][number] {
  if (!skill.body.trim()) throw new Error(`Discovered Agent skill ${skill.name} has no procedure body.`);
  assertNoSecretLikeText([skill.name, skill.description, skill.body], `Discovered skill '${skill.name}'`);
  return {
    name: skill.name,
    description: skill.description || `Imported skill from ${skill.origin} skill file.`,
    procedure: skill.body,
    triggers: splitFrontmatterList(skill.frontmatter.triggers),
    tags: splitFrontmatterList(skill.frontmatter.tags),
  };
}

function discoveredRoutineToTemplate(routine: DiscoveredRoutineRecord): AgentRuntimeProfileStarterTemplate['routines'][number] {
  if (!routine.steps.trim()) throw new Error(`Discovered Agent routine ${routine.name} has no steps.`);
  assertNoSecretLikeText([routine.name, routine.description, routine.steps], `Discovered routine '${routine.name}'`);
  return {
    name: routine.name,
    description: routine.description || `Imported routine from ${routine.origin} markdown file.`,
    steps: routine.steps,
    triggers: splitFrontmatterList(routine.frontmatter.triggers),
    tags: splitFrontmatterList(routine.frontmatter.tags),
  };
}

function discoveredPersonaToTemplate(persona: DiscoveredPersonaRecord): AgentRuntimeProfileStarterTemplate['persona'] {
  assertNoSecretLikeText([persona.name, persona.description, persona.body], `Discovered persona '${persona.name}'`);
  return {
    name: persona.name,
    description: persona.description || `Imported persona from ${persona.origin} markdown file.`,
    body: persona.body,
    tags: splitFrontmatterList(persona.frontmatter.tags),
    triggers: splitFrontmatterList(persona.frontmatter.triggers),
  };
}

function readTemplateTextBlock(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Starter template ${field} is required.`);
  return value.trim();
}

function readTemplateObject(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Starter template ${field} must be an object.`);
  return value;
}

function parseTemplateSkill(value: unknown): AgentRuntimeProfileStarterTemplate['skills'][number] {
  const record = readTemplateObject(value, 'skill');
  return {
    name: readTemplateTextBlock(record.name, 'skill.name'),
    description: readTemplateTextBlock(record.description, 'skill.description'),
    procedure: readTemplateTextBlock(record.procedure, 'skill.procedure'),
    triggers: parseStringArray(record.triggers),
    tags: parseStringArray(record.tags),
  };
}

function parseTemplateRoutine(value: unknown): AgentRuntimeProfileStarterTemplate['routines'][number] {
  const record = readTemplateObject(value, 'routine');
  return {
    name: readTemplateTextBlock(record.name, 'routine.name'),
    description: readTemplateTextBlock(record.description, 'routine.description'),
    steps: readTemplateTextBlock(record.steps, 'routine.steps'),
    triggers: parseStringArray(record.triggers),
    tags: parseStringArray(record.tags),
  };
}

function parseTemplateVibe(value: unknown): AgentRuntimeProfileStarterTemplate['vibe'] | undefined {
  if (value === undefined || value === null) return undefined;
  const record = readTemplateObject(value, 'vibe');
  const body = readTemplateTextBlock(record.body, 'vibe.body');
  assertNoSecretLikeText([body], 'Agent starter VIBE.md');
  const source = record.source === 'template' ? 'template' : 'discovered';
  const appliedAs = record.appliedAs === 'global' ? 'global' : 'global';
  const truncated = typeof record.truncated === 'number' && Number.isFinite(record.truncated)
    ? Math.max(0, Math.trunc(record.truncated))
    : 0;
  return {
    body,
    source,
    appliedAs,
    sourcePaths: parseStringArray(record.sourcePaths),
    truncated,
  };
}

function profileTemplateVibeShellPaths(shellPaths: AgentRuntimeProfileTemplateShellPaths): Parameters<typeof discoverVibeFiles>[0] {
  return {
    homeDirectory: shellPaths.homeDirectory,
    workingDirectory: shellPaths.workingDirectory,
    resolveUserPath: shellPaths.resolveUserPath ?? ((...parts: string[]) => join(shellPaths.homeDirectory, '.goodvibes', ...parts)),
    expandHomePath: shellPaths.expandHomePath ?? ((value: string) => value.startsWith('~/') ? join(shellPaths.homeDirectory, value.slice(2)) : value),
    resolveWorkspacePath: shellPaths.resolveWorkspacePath ?? ((value: string) => {
      const expanded = value.startsWith('~/') ? join(shellPaths.homeDirectory, value.slice(2)) : value;
      return isAbsolute(expanded) ? resolve(expanded) : resolve(shellPaths.workingDirectory, expanded);
    }),
  };
}

function discoveredVibeToTemplate(
  shellPaths: AgentRuntimeProfileTemplateExportOptions['shellPaths'],
): AgentRuntimeProfileStarterTemplate['vibe'] | undefined {
  if (!shellPaths) throw new Error('Including VIBE.md in a starter template requires shell path context.');
  const snapshot = discoverVibeFiles(profileTemplateVibeShellPaths(shellPaths));
  if (snapshot.blocked.length > 0) {
    throw new Error(`Cannot include VIBE.md in a starter template while ${snapshot.blocked.length} VIBE.md file is blocked. Run /vibe status and repair it first.`);
  }
  if (snapshot.files.length === 0) return undefined;
  const body = snapshot.files.map((file) => [
    `## ${file.scope === 'global' ? 'Global' : 'Project'} VIBE.md`,
    `Source: ${file.path}`,
    '',
    file.body,
    file.truncated ? '[This VIBE.md was truncated before profile starter export.]' : '',
  ].filter(Boolean).join('\n')).join('\n\n');
  assertNoSecretLikeText([body], 'Agent starter VIBE.md');
  return {
    body,
    source: 'discovered',
    appliedAs: 'global',
    sourcePaths: snapshot.files.map((file) => file.path),
    truncated: snapshot.files.filter((file) => file.truncated).length,
  };
}

function withOptionalVibe(
  template: AgentRuntimeProfileStarterTemplate,
  options: AgentRuntimeProfileTemplateExportOptions | undefined,
): AgentRuntimeProfileStarterTemplate {
  if (options?.includeVibe !== true) return template;
  const vibe = discoveredVibeToTemplate(options.shellPaths);
  return vibe ? { ...template, vibe } : template;
}

function parseStarterTemplate(raw: unknown, source: AgentRuntimeProfileTemplateSource, path?: string): AgentRuntimeProfileStarterTemplate {
  const file = readTemplateObject(raw, 'file');
  const templateRecord = readTemplateObject(file.template ?? raw, 'template');
  const id = assertValidAgentRuntimeProfileId(readTemplateTextBlock(templateRecord.id, 'id'));
  const personaRecord = readTemplateObject(templateRecord.persona, 'persona');
  const skills = Array.isArray(templateRecord.skills) ? templateRecord.skills.map(parseTemplateSkill) : [];
  const routines = Array.isArray(templateRecord.routines) ? templateRecord.routines.map(parseTemplateRoutine) : [];
  const vibe = parseTemplateVibe(templateRecord.vibe);
  if (skills.length === 0) throw new Error(`Starter template ${id} must include at least one skill.`);
  if (routines.length === 0) throw new Error(`Starter template ${id} must include at least one routine.`);
  const persona = {
    name: readTemplateTextBlock(personaRecord.name, 'persona.name'),
    description: readTemplateTextBlock(personaRecord.description, 'persona.description'),
    body: readTemplateTextBlock(personaRecord.body, 'persona.body'),
    tags: parseStringArray(personaRecord.tags),
    triggers: parseStringArray(personaRecord.triggers),
  };
  return {
    id,
    source,
    path,
    name: readTemplateTextBlock(templateRecord.name, 'name'),
    description: readTemplateTextBlock(templateRecord.description, 'description'),
    personaName: typeof templateRecord.personaName === 'string' && templateRecord.personaName.trim() ? templateRecord.personaName.trim() : persona.name,
    skillNames: skills.map((skill) => skill.name),
    routineNames: routines.map((routine) => routine.name),
    persona,
    skills,
    routines,
    ...(vibe ? { vibe: { ...vibe, source: 'template' } } : {}),
  };
}

function readLocalTemplate(path: string): AgentRuntimeProfileStarterTemplate | null {
  try {
    return parseStarterTemplate(JSON.parse(readFileSync(path, 'utf-8')), 'local', path);
  } catch {
    return null;
  }
}

function listLocalTemplates(baseHomeDirectory: string): readonly AgentRuntimeProfileStarterTemplate[] {
  const root = getAgentRuntimeProfileTemplatesRoot(baseHomeDirectory);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => readLocalTemplate(join(root, entry)))
    .filter((entry): entry is AgentRuntimeProfileStarterTemplate => entry !== null)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function resolveAgentRuntimeProfileTemplate(templateId: AgentRuntimeProfileTemplateId, baseHomeDirectory?: string): AgentRuntimeProfileStarterTemplate {
  const id = assertValidAgentRuntimeProfileId(templateId);
  const builtin = STARTER_TEMPLATES.find((template) => template.id === id);
  if (builtin) return builtin;
  const local = baseHomeDirectory ? listLocalTemplates(baseHomeDirectory).find((template) => template.id === id) : undefined;
  if (local) return local;
  const suffix = baseHomeDirectory ? ' Use profiles templates to list starters.' : '';
  throw new Error(`Unknown Agent starter profile template ${templateId}.${suffix}`);
}

export function listAgentRuntimeProfileTemplates(baseHomeDirectory?: string): readonly AgentRuntimeProfileTemplateSummary[] {
  const builtins = STARTER_TEMPLATES.map(summarizeTemplate);
  const locals = baseHomeDirectory ? listLocalTemplates(baseHomeDirectory).map(summarizeTemplate) : [];
  return [...builtins, ...locals];
}

export function getAgentRuntimeProfileTemplate(templateId: AgentRuntimeProfileTemplateId, baseHomeDirectory?: string): AgentRuntimeProfileTemplateSummary {
  return summarizeTemplate(resolveAgentRuntimeProfileTemplate(templateId, baseHomeDirectory));
}

export function getAgentRuntimeProfileTemplateFile(templateId: AgentRuntimeProfileTemplateId, baseHomeDirectory?: string): AgentRuntimeProfileStarterTemplateFile {
  return templateFilePayload(resolveAgentRuntimeProfileTemplate(templateId, baseHomeDirectory));
}

function templateFilePayload(template: AgentRuntimeProfileStarterTemplate): AgentRuntimeProfileStarterTemplateFile {
  return {
    version: 1,
    template: {
      ...template,
      source: 'local',
      path: undefined,
    },
  };
}

export function exportAgentRuntimeProfileTemplate(
  baseHomeDirectory: string,
  templateId: AgentRuntimeProfileTemplateId,
  outputPath: string,
  options: AgentRuntimeProfileTemplateExportOptions = {},
): AgentRuntimeProfileTemplateSummary {
  const template = withOptionalVibe(resolveAgentRuntimeProfileTemplate(templateId, baseHomeDirectory), options);
  const target = outputPath.trim();
  if (!target) throw new Error('Template export path is required.');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(templateFilePayload(template), null, 2)}\n`, 'utf-8');
  return { ...summarizeTemplate(template), path: target };
}

export function importAgentRuntimeProfileTemplate(baseHomeDirectory: string, sourcePath: string): AgentRuntimeProfileTemplateSummary {
  const source = sourcePath.trim();
  if (!source) throw new Error('Template import path is required.');
  const parsed = parseStarterTemplate(JSON.parse(readFileSync(source, 'utf-8')), 'local');
  const root = getAgentRuntimeProfileTemplatesRoot(baseHomeDirectory);
  mkdirSync(root, { recursive: true });
  const target = join(root, `${parsed.id}.json`);
  writeFileSync(target, `${JSON.stringify(templateFilePayload({ ...parsed, source: 'local', path: target }), null, 2)}\n`, 'utf-8');
  return summarizeTemplate({ ...parsed, source: 'local', path: target });
}

export async function createAgentRuntimeProfileTemplateFromDiscovered(
  shellPaths: Pick<ShellPathService, 'homeDirectory' | 'workingDirectory'>,
  options: CreateAgentRuntimeProfileTemplateFromDiscoveredOptions,
): Promise<AgentRuntimeProfileTemplateSummary> {
  const id = assertValidAgentRuntimeProfileId(options.id);
  const [personas, skills, routines] = await Promise.all([
    discoverPersonas(shellPaths),
    discoverSkills(shellPaths),
    discoverRoutines(shellPaths),
  ]);
  const selectedPersona = selectDiscoveredRecord(personas, options.persona, 'persona');
  const selectedSkills = selectDiscoveredRecords(skills, options.skills, 'skill');
  const selectedRoutines = selectDiscoveredRecords(routines, options.routines, 'routine');
  const target = join(getAgentRuntimeProfileTemplatesRoot(shellPaths.homeDirectory), `${id}.json`);
  if (existsSync(target) && options.replace !== true) {
    throw new Error(`Agent starter template already exists ${id}. Rerun with --replace to overwrite it.`);
  }
  const persona = discoveredPersonaToTemplate(selectedPersona);
  const vibe = options.includeVibe ? discoveredVibeToTemplate(shellPaths) : undefined;
  const template: AgentRuntimeProfileStarterTemplate = {
    id,
    source: 'local',
    path: target,
    name: options.name?.trim() || `${persona.name} Starter`,
    description: options.description?.trim() || 'Agent starter template assembled from discovered local persona, skill, and routine files.',
    personaName: persona.name,
    skillNames: selectedSkills.map((skill) => skill.name),
    routineNames: selectedRoutines.map((routine) => routine.name),
    persona,
    skills: selectedSkills.map(discoveredSkillToTemplate),
    routines: selectedRoutines.map(discoveredRoutineToTemplate),
    ...(vibe ? { vibe } : {}),
  };
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(templateFilePayload(template), null, 2)}\n`, 'utf-8');
  return summarizeTemplate(template);
}

export async function createAgentRuntimeProfileFromDiscovered(
  shellPaths: Pick<ShellPathService, 'homeDirectory' | 'workingDirectory'>,
  options: CreateAgentRuntimeProfileFromDiscoveredOptions,
): Promise<{
  readonly profile: AgentRuntimeProfileInfo;
  readonly template: AgentRuntimeProfileTemplateSummary;
}> {
  const profileId = assertValidAgentRuntimeProfileId(options.profileName);
  const resolution = resolveAgentRuntimeProfileHome(shellPaths.homeDirectory, profileId);
  if (existsSync(resolution.homeDirectory)) {
    throw new Error(`Agent profile already exists: ${resolution.id}`);
  }
  const templateId = assertValidAgentRuntimeProfileId(options.templateId ?? profileId);
  const template = await createAgentRuntimeProfileTemplateFromDiscovered(shellPaths, {
    id: templateId,
    name: options.name,
    description: options.description,
    persona: options.persona,
    skills: options.skills,
    routines: options.routines,
    includeVibe: options.includeVibe,
    replace: options.replace,
  });
  const profile = createAgentRuntimeProfile(shellPaths.homeDirectory, profileId, { templateId: template.id });
  return { profile, template };
}

function createMissingSkill(registry: AgentSkillRegistry, template: AgentRuntimeProfileStarterTemplate['skills'][number]): string {
  const existing = registry.get(template.name);
  if (existing) return existing.id;
  return registry.create({
    name: template.name,
    description: template.description,
    procedure: template.procedure,
    triggers: template.triggers,
    tags: template.tags,
    enabled: true,
    source: 'system',
    provenance: `goodvibes-agent starter:${template.name}`,
  }).id;
}

function createMissingRoutine(registry: AgentRoutineRegistry, template: AgentRuntimeProfileStarterTemplate['routines'][number]): string {
  const existing = registry.get(template.name);
  if (existing) return existing.id;
  return registry.create({
    name: template.name,
    description: template.description,
    steps: template.steps,
    triggers: template.triggers,
    tags: template.tags,
    enabled: true,
    source: 'system',
    provenance: `goodvibes-agent starter:${template.name}`,
  }).id;
}

function writeTemplateVibe(homeDirectory: string, template: AgentRuntimeProfileStarterTemplate): string | undefined {
  if (!template.vibe?.body.trim()) return undefined;
  assertNoSecretLikeText([template.vibe.body], 'Agent starter VIBE.md');
  const path = join(homeDirectory, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT, 'VIBE.md');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${template.vibe.body.trimEnd()}\n`, 'utf-8');
  return path;
}

export function applyAgentRuntimeProfileTemplate(homeDirectory: string, templateId: AgentRuntimeProfileTemplateId, baseHomeDirectory?: string): AgentRuntimeProfileTemplateApplication {
  const template = resolveAgentRuntimeProfileTemplate(templateId, baseHomeDirectory);
  const personaRegistry = new AgentPersonaRegistry(profileStorePath(homeDirectory, 'personas', 'personas.json'));
  const skillRegistry = new AgentSkillRegistry(profileStorePath(homeDirectory, 'skills', 'skills.json'));
  const routineRegistry = new AgentRoutineRegistry(profileStorePath(homeDirectory, 'routines', 'routines.json'));
  const existingPersona = personaRegistry.get(template.persona.name);
  const persona = existingPersona ?? personaRegistry.create({
    name: template.persona.name,
    description: template.persona.description,
    body: template.persona.body,
    tags: template.persona.tags,
    triggers: template.persona.triggers,
    source: 'system',
    provenance: `goodvibes-agent starter:${template.name}`,
  });
  personaRegistry.setActive(persona.id);
  const skillIds = template.skills.map((skill) => createMissingSkill(skillRegistry, skill));
  const routineIds = template.routines.map((routine) => createMissingRoutine(routineRegistry, routine));
  const vibePath = writeTemplateVibe(homeDirectory, template);
  return {
    id: template.id,
    name: template.name,
    source: template.source,
    appliedAt: new Date().toISOString(),
    personaIds: [persona.id],
    skillIds,
    routineIds,
    ...(vibePath ? { vibePath } : {}),
  };
}

export function listAgentRuntimeProfiles(baseHomeDirectory: string): readonly AgentRuntimeProfileInfo[] {
  const root = getAgentRuntimeProfilesRoot(baseHomeDirectory);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((entry) => PROFILE_ID_PATTERN.test(entry) && !entry.includes('..'))
    .filter((entry) => {
      try {
        return statSync(join(root, entry)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => buildProfileInfo(baseHomeDirectory, entry));
}

export function createAgentRuntimeProfile(baseHomeDirectory: string, profileName: string, options: CreateAgentRuntimeProfileOptions = {}): AgentRuntimeProfileInfo {
  const resolution = resolveAgentRuntimeProfileHome(baseHomeDirectory, profileName);
  if (existsSync(resolution.homeDirectory)) {
    throw new Error(`Agent profile already exists: ${resolution.id}`);
  }
  mkdirSync(resolution.homeDirectory, { recursive: true });
  const createdAt = new Date().toISOString();
  const appliedTemplate = options.templateId
    ? applyAgentRuntimeProfileTemplate(resolution.homeDirectory, options.templateId, baseHomeDirectory)
    : undefined;
  writeFileSync(
    join(resolution.homeDirectory, PROFILE_CREATED_FILE),
    `${JSON.stringify({
      id: resolution.id,
      createdAt,
      starterTemplate: appliedTemplate,
    }, null, 2)}\n`,
    'utf-8',
  );
  return {
    ...resolution,
    createdAt,
    starterTemplateId: appliedTemplate?.id,
    starterTemplateName: appliedTemplate?.name,
    starterTemplateApplication: appliedTemplate,
  };
}

export function setAgentRuntimeProfileSelection(baseHomeDirectory: string, profileName: string): AgentRuntimeProfileSelection {
  const resolution = resolveAgentRuntimeProfileHome(baseHomeDirectory, profileName);
  if (!existsSync(resolution.homeDirectory)) {
    throw new Error(`Agent profile not found ${resolution.id}`);
  }
  const path = getAgentRuntimeProfileSelectionPath(baseHomeDirectory);
  mkdirSync(dirname(path), { recursive: true });
  const selectedAt = new Date().toISOString();
  writeFileSync(
    path,
    `${JSON.stringify({
      profileId: resolution.id,
      selectedAt,
    }, null, 2)}\n`,
    'utf-8',
  );
  return {
    ...resolution,
    selectedAt,
    path,
    exists: true,
  };
}

export function clearAgentRuntimeProfileSelection(baseHomeDirectory: string): boolean {
  const path = getAgentRuntimeProfileSelectionPath(baseHomeDirectory);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

export function deleteAgentRuntimeProfile(baseHomeDirectory: string, profileName: string): boolean {
  const resolution = resolveAgentRuntimeProfileHome(baseHomeDirectory, profileName);
  if (!existsSync(resolution.homeDirectory)) return false;
  rmSync(resolution.homeDirectory, { recursive: true, force: true });
  const selection = readAgentRuntimeProfileSelection(baseHomeDirectory);
  if (selection?.id === resolution.id) clearAgentRuntimeProfileSelection(baseHomeDirectory);
  return true;
}
