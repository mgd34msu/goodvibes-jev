/** Parse fenced Markdown grammar only; the language is never inferred here. */
export function readCanonicalFencedBlock(content: string, start: number, end: number): { code: string; tag: string } {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > content.length
    || (start > 0 && content[start - 1] !== '\n')) throw new Error('Unsupported code source');
  const raw = content.slice(start, end);
  const lines = raw.split(/\r?\n/);
  const open = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)$/.exec(lines[0] ?? '');
  if (!open || lines.length < 2) throw new Error('Unsupported code source');
  const marker = open[2]!; const info = open[3]!.trim();
  if (marker[0] === '`' && info.includes('`')) throw new Error('Unsupported code source');
  const last = lines.at(-1) === '' ? lines.length - 2 : lines.length - 1;
  const close = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(lines[last] ?? '');
  if (!close || close[2]![0] !== marker[0] || close[2]!.length < marker.length) throw new Error('Unsupported code source');
  const body = lines.slice(1, last);
  // A request cannot cross an earlier closing fence and manufacture a larger source.
  if (body.some(line => { const match = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(line); return match && match[2]![0] === marker[0] && match[2]!.length >= marker.length; })) throw new Error('Unsupported code source');
  const indent = open[1]!.length;
  const code = body.map(line => { let offset = 0; while (offset < indent && line[offset] === ' ') offset++; return line.slice(offset); }).join('\n');
  return { code, tag: info.split(/[ \t]+/)[0] ?? '' };
}
