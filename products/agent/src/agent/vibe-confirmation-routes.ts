export function vibeRouteArg(value: string): string {
  return JSON.stringify(value);
}

function routeLine(id: string, route: string): string {
  return `    ${id} ${route}`;
}

export function vibeInitConfirmationRoutes(scope: 'project' | 'global', force = false): Record<string, string> {
  const model = [
    'vibe action:"init"',
    `scope:${vibeRouteArg(scope)}`,
    force ? 'force:true' : '',
    'confirm:true',
    'explicitUserRequest:"..."',
  ].filter(Boolean).join(' ');
  const cli = [
    '/vibe init',
    scope === 'global' ? '--global' : '',
    force ? '--force' : '',
    '--yes',
  ].filter(Boolean).join(' ');
  return { model, cli };
}

export function vibeImportPersonaConfirmationRoutes(input: {
  readonly reference: string;
  readonly name: string;
  readonly description: string;
  readonly review: boolean;
  readonly use: boolean;
}): Record<string, string> {
  const model = [
    'vibe action:"import_persona"',
    `reference:${vibeRouteArg(input.reference)}`,
    input.name ? `name:${vibeRouteArg(input.name)}` : '',
    input.description ? `description:${vibeRouteArg(input.description)}` : '',
    input.review ? 'review:true' : '',
    input.use ? 'use:true' : '',
    'confirm:true',
    'explicitUserRequest:"..."',
  ].filter(Boolean).join(' ');
  const cli = [
    '/vibe import-persona',
    vibeRouteArg(input.reference),
    input.name ? `--name ${vibeRouteArg(input.name)}` : '',
    input.description ? `--description ${vibeRouteArg(input.description)}` : '',
    input.review ? '--review' : '',
    input.use ? '--use' : '',
    '--yes',
  ].filter(Boolean).join(' ');
  return { model, cli };
}

export function formatVibeConfirmationRouteLines(routes: Record<string, string>): readonly string[] {
  const entries = Object.entries(routes).filter(([, route]) => route.trim() !== '');
  if (entries.length === 0) return [];
  return [
    '  confirmationRoutes',
    ...entries.map(([id, route]) => routeLine(id, route)),
  ];
}
