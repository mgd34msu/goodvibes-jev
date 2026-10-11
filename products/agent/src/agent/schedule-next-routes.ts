export function scheduleRouteArg(value: string): string {
  return JSON.stringify(value);
}

function routeLine(id: string, route: string): string {
  return `    ${id} ${route}`;
}

export function scheduleNextRouteLines(scheduleId: string, options: { readonly deleted?: boolean } = {}): readonly string[] {
  const id = scheduleId && scheduleId !== '(unknown)' ? scheduleId : '...';
  const query = id === '...' ? '' : ` query:${scheduleRouteArg(id)}`;
  const scheduleIdArg = `scheduleId:${scheduleRouteArg(id)}`;
  const lines = [
    '  nextRoutes',
    routeLine('listSchedules', `schedule action:"list"${query}`),
    routeLine('autonomyQueue', 'autonomy action:"item" queueItemId:"connected-schedules" includeParameters:true'),
  ];
  if (options.deleted) {
    lines.push(
      routeLine('createAutonomousSchedule', 'schedule action:"create" task:"..." successCriteria:"..." every:"..."'),
      routeLine('createReminder', 'schedule action:"remind" message:"..." at:"..."'),
    );
    return lines;
  }
  lines.push(
    routeLine('runNow', `schedule action:"run" ${scheduleIdArg}`),
    routeLine('editSchedule', `schedule action:"edit" ${scheduleIdArg}`),
    routeLine('pauseSchedule', `schedule action:"pause" ${scheduleIdArg}`),
    routeLine('resumeSchedule', `schedule action:"resume" ${scheduleIdArg}`),
    routeLine('deleteSchedule', `schedule action:"delete" ${scheduleIdArg}`),
  );
  return lines;
}

export function scheduleConfirmationRouteLines(routes: Record<string, string>): readonly string[] {
  const entries = Object.entries(routes).filter(([, route]) => route.trim() !== '');
  if (entries.length === 0) return [];
  return [
    '  confirmationRoutes',
    ...entries.map(([id, route]) => routeLine(id, route)),
  ];
}
