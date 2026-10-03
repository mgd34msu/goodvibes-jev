import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSkillStandardMarkdown, renderSkillStandardMarkdown, writeSkillStandardFile } from '../../agent/skill-standard.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

describe('parseSkillStandardMarkdown', () => {
  test('parses valid SKILL.md with name and description', () => {
    const content = '---\nname: Morning Brief\ndescription: Prepare a daily briefing.\n---\nCheck calendar and tasks first.\n';
    const result = parseSkillStandardMarkdown(content);
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.name).toBe('Morning Brief');
    expect(result.description).toBe('Prepare a daily briefing.');
    expect(result.body).toBe('Check calendar and tasks first.');
  });

  test('tolerates extra frontmatter keys', () => {
    const content = '---\nname: Example Skill\ndescription: Does something useful.\nlicense: MIT\nversion: 1.0\nauthor: Alice\n---\nStep one.\n';
    const result = parseSkillStandardMarkdown(content);
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.name).toBe('Example Skill');
    expect(result.description).toBe('Does something useful.');
    expect(result.body).toBe('Step one.');
  });

  test('rejects file missing name field', () => {
    const content = '---\ndescription: No name here.\n---\nBody.\n';
    const result = parseSkillStandardMarkdown(content);
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toContain('name');
  });

  test('rejects file missing description field', () => {
    const content = '---\nname: Only A Name\n---\nBody.\n';
    const result = parseSkillStandardMarkdown(content);
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toContain('description');
  });

  test('rejects file with no frontmatter', () => {
    const content = 'No frontmatter here, just plain text.';
    const result = parseSkillStandardMarkdown(content);
    expect('error' in result).toBe(true);
  });

  test('rejects secret-looking content in body', () => {
    const content = '---\nname: Bad Skill\ndescription: Contains a secret.\n---\npassword=hunter2-value\n';
    const result = parseSkillStandardMarkdown(content);
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error.toLowerCase()).toContain('secret');
  });

  test('rejects secret-looking content in name', () => {
    const content = '---\nname: password=hunter2-value\ndescription: Has secret name.\n---\nSafe body.\n';
    const result = parseSkillStandardMarkdown(content);
    expect('error' in result).toBe(true);
  });

  test('rejects secret-looking content in description', () => {
    const content = '---\nname: Safe Name\ndescription: token=abc123def456ghi789\n---\nSafe body.\n';
    const result = parseSkillStandardMarkdown(content);
    expect('error' in result).toBe(true);
  });

  test('description value with colon is preserved correctly', () => {
    const content = '---\nname: API Brief\ndescription: Check the API: status and rate limits.\n---\nUse read-only routes.\n';
    const result = parseSkillStandardMarkdown(content);
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.description).toBe('Check the API: status and rate limits.');
  });
});

describe('renderSkillStandardMarkdown', () => {
  test('renders to valid SKILL.md format', () => {
    const skill = { name: 'Morning Brief', description: 'Prepare a daily briefing.', procedure: 'Check calendar and tasks first.' };
    const rendered = renderSkillStandardMarkdown(skill);
    expect(rendered).toBe('---\nname: Morning Brief\ndescription: Prepare a daily briefing.\n---\nCheck calendar and tasks first.\n');
  });

  test('renders multiline procedure correctly', () => {
    const skill = { name: 'Multi Step', description: 'Runs several steps.', procedure: 'Step 1.\nStep 2.\nStep 3.' };
    const rendered = renderSkillStandardMarkdown(skill);
    expect(rendered.startsWith('---\n')).toBe(true);
    expect(rendered).toContain('Step 1.\nStep 2.');
  });
});

describe('round-trip: parse(render(skill)) recovers original fields', () => {
  test('simple skill round-trips', () => {
    const original = { name: 'Status Review', description: 'Check visible status.', procedure: 'Inspect the health endpoint and report any warnings.' };
    const rendered = renderSkillStandardMarkdown(original);
    const parsed = parseSkillStandardMarkdown(rendered);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    expect(parsed.name).toBe(original.name);
    expect(parsed.description).toBe(original.description);
    expect(parsed.body).toBe(original.procedure);
  });

  test('skill with colon in description round-trips', () => {
    const original = { name: 'API Brief', description: 'Check the API: status and rate limits.', procedure: 'Use read-only routes only.' };
    const rendered = renderSkillStandardMarkdown(original);
    const parsed = parseSkillStandardMarkdown(rendered);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    expect(parsed.description).toBe(original.description);
  });

  test('description with embedded newline collapses to single line: frontmatter unbroken', () => {
    // Skill created with a multi-line description (e.g. via API with \n in the string).
    // render must collapse it so the YAML frontmatter is never broken across lines,
    // and the recovered description equals the collapsed form.
    const original = { name: 'Newline Desc', description: 'line1\nline2', procedure: 'Do the thing.' };
    const rendered = renderSkillStandardMarkdown(original);
    // The rendered frontmatter must not contain a bare newline inside the description value.
    const frontmatterBlock = rendered.match(/^---\n([\s\S]*?)\n---/);
    expect(frontmatterBlock).not.toBeNull();
    const descLine = frontmatterBlock![1].split('\n').find((l) => l.startsWith('description:'));
    expect(descLine).toBeDefined();
    // The description line must be a single line with no embedded newlines.
    expect(descLine).toBe('description: line1 line2');
    // Round-trip: parse recovers the collapsed single-line description.
    const parsed = parseSkillStandardMarkdown(rendered);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    expect(parsed.description).toBe('line1 line2');
    expect(parsed.name).toBe(original.name);
    expect(parsed.body).toBe(original.procedure);
  });
});

describe('parseSkillStandardMarkdown: input normalization', () => {
  test('parses SKILL.md with CRLF line endings (round-trip)', () => {
    const content = '---\r\nname: CRLF Skill\r\ndescription: Authored with Windows line endings.\r\n---\r\nDo the thing.\r\n';
    const result = parseSkillStandardMarkdown(content);
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.name).toBe('CRLF Skill');
    expect(result.description).toBe('Authored with Windows line endings.');
    expect(result.body).toBe('Do the thing.');
  });

  test('parses SKILL.md with leading UTF-8 BOM', () => {
    const bom = '﻿';
    const content = `${bom}---\nname: BOM Skill\ndescription: File starts with a BOM.\n---\nStep one.\n`;
    const result = parseSkillStandardMarkdown(content);
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.name).toBe('BOM Skill');
    expect(result.description).toBe('File starts with a BOM.');
    expect(result.body).toBe('Step one.');
  });
});

describe('writeSkillStandardFile', () => {
  test('writes SKILL.md to <destDir>/<slug>/SKILL.md', () => {
    const tmpDir = makeProjectTempDir('goodvibes-skill-standard');
    const skill = { name: 'Morning Brief', description: 'Prepare a daily briefing.', procedure: 'Check calendar.' };
    const written = writeSkillStandardFile(skill, tmpDir);
    expect(written).toBe(join(tmpDir, 'morning-brief', 'SKILL.md'));
    const content = readFileSync(written, 'utf-8');
    const parsed = parseSkillStandardMarkdown(content);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    expect(parsed.name).toBe('Morning Brief');
  });

  test('rejects overwrite without flag', () => {
    const tmpDir = makeProjectTempDir('goodvibes-skill-standard');
    const skill = { name: 'Status Review', description: 'Check status.', procedure: 'Inspect.' };
    writeSkillStandardFile(skill, tmpDir);
    expect(() => writeSkillStandardFile(skill, tmpDir)).toThrow('already exists');
  });

  test('overwrites with flag', () => {
    const tmpDir = makeProjectTempDir('goodvibes-skill-standard');
    const skill = { name: 'Status Review', description: 'Check status.', procedure: 'Inspect.' };
    writeSkillStandardFile(skill, tmpDir);
    const written = writeSkillStandardFile(skill, tmpDir, true);
    expect(written).toBeTruthy();
  });

  test('throws on name that produces empty slug', () => {
    const tmpDir = makeProjectTempDir('goodvibes-skill-standard');
    const skill = { name: '---', description: 'Punct only name.', procedure: 'Step.' };
    expect(() => writeSkillStandardFile(skill, tmpDir)).toThrow('empty folder name');
  });
});
