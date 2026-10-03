import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertNoSecretLikeText } from './persona-registry.ts';
import type { AgentSkillRecord } from './skill-registry-types.ts';

export interface SkillStandardParsed {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

export interface SkillStandardParseError {
  readonly error: string;
}

function parseStandardFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex < 1) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

/**
 * Parse a SKILL.md in the open skill standard format.
 * Frontmatter must contain `name` and `description`; extra keys are tolerated.
 * Returns a parse error if either required key is absent or secret-looking content is found.
 */
export function parseSkillStandardMarkdown(content: string): SkillStandardParsed | SkillStandardParseError {
  content = content.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const frontmatter = parseStandardFrontmatter(content);
  const name = (frontmatter['name'] ?? '').trim();
  const description = (frontmatter['description'] ?? '').trim();

  if (!name) return { error: 'SKILL.md is missing required frontmatter field: name' };
  if (!description) return { error: 'SKILL.md is missing required frontmatter field: description' };

  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();

  try {
    assertNoSecretLikeText([name, description, body], 'Shared skill');
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Secret-looking content rejected.' };
  }

  return { name, description, body };
}

/**
 * Render a local skill record to the open skill standard format.
 * Produces `---\nname: ...\ndescription: ...\n---\n<body>\n`
 * Round-trip safe: parse(render(skill)) recovers name, description, body.
 */
export function renderSkillStandardMarkdown(
  skill: Pick<AgentSkillRecord, 'name' | 'description' | 'procedure'>,
): string {
  const nameLine = `name: ${skill.name}`;
  // Collapse any embedded newlines/runs of whitespace so the description
  // never spans more than one line and cannot break YAML frontmatter.
  const safeDescription = skill.description.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  const descLine = `description: ${safeDescription}`;
  const body = skill.procedure.trimEnd();
  return `---\n${nameLine}\n${descLine}\n---\n${body}\n`;
}

/**
 * Write a skill record as a SKILL.md inside `<destDir>/<slug>/SKILL.md`.
 * Throws if the file already exists and `overwrite` is not true.
 * Returns the path that was written.
 */
export function writeSkillStandardFile(
  skill: Pick<AgentSkillRecord, 'name' | 'description' | 'procedure'>,
  destDir: string,
  overwrite = false,
): string {
  const slug = skill.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (!slug) {
    throw new Error('skill name produces an empty folder name');
  }
  const dir = join(destDir, slug);
  const filePath = join(dir, 'SKILL.md');

  if (!overwrite && existsSync(filePath)) {
    throw new Error(`Skill file already exists at ${filePath}. Pass --overwrite to replace it.`);
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, renderSkillStandardMarkdown(skill), 'utf-8');
  return filePath;
}
