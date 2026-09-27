/**
 * The whole task route catalog: every route the route selector chooses
 * among, and main-conversation-first, the route a plan prefers when no
 * catalog route fits (the selection's "none").
 */
import { SETUP_ROUTES } from './catalog-setup.js';
import { SURFACE_ROUTES } from './catalog-surfaces.js';
import { WORK_ROUTES } from './catalog-work.js';
import { quote } from './text.js';
import type { TaskRouteDraft, TaskRouteEntry } from './types.js';

/** Every catalog route, in the order the agent's candidate files added them. */
export const TASK_ROUTES: readonly TaskRouteEntry[] = [...SETUP_ROUTES, ...WORK_ROUTES, ...SURFACE_ROUTES];

const ROUTES_BY_ID: ReadonlyMap<string, TaskRouteEntry> = new Map(TASK_ROUTES.map((entry) => [entry.id, entry]));

/** The catalog entry with this selector id; throws on an id the catalog does not hold. */
export function taskRouteEntry(id: string): TaskRouteEntry {
  const entry = ROUTES_BY_ID.get(id);
  if (entry === undefined) throw new RangeError(`task route catalog has no route "${id}"`);
  return entry;
}

export const MAIN_CONVERSATION_ID = 'main-conversation-first';

/** The route a plan prefers when no specialized route fits the request. */
export function mainConversationRoute(request: string): TaskRouteDraft {
  return {
    id: MAIN_CONVERSATION_ID,
    label: 'Main conversation first',
    userSurface: 'Main conversation',
    userOutcome: 'Answer or plan directly before escalating into a specialized tool or workspace.',
    why: 'The request does not clearly need a specialized route yet.',
    modelRoute: 'main conversation',
    inspectRoute: `workspace action:"actions" query:${quote(request, 72)}`,
    userRoute: 'Main conversation',
    requiresConfirmation: false,
    supportingRoutes: [
      `route action:"plan" query:${quote(request, 72)}`,
      `workspace action:"actions" query:${quote(request, 72)}`,
    ],
    policy: 'Stay in the main conversation unless a visible specialized route improves clarity, durability, safety, or autonomy.',
  };
}
