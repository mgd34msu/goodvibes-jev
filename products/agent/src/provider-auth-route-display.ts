export function formatProviderAuthRouteId(route: string): string {
  return route === 'service-oauth' ? 'provider-oauth' : route;
}

export function formatProviderAuthRouteLabel(route: string, label?: string): string {
  if (route === 'service-oauth') return 'Provider OAuth';
  const trimmed = label?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : formatProviderAuthRouteId(route);
}
