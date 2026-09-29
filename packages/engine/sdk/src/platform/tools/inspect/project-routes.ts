/**
 * The HTTP routes a project declares, for inspect modes `api`, `api_spec`,
 * `api_validate` and `api_sync`. Next.js App Router routes are facts of the
 * framework's file convention (a route.ts exporting a function named after
 * the method). A Next.js pages/api handler's methods, and whether a verb
 * method call registers an Express, Fastify or Hono route, are read by
 * `engine.tools.api-routes` (tools/batteries/api-routes.ts). A route is
 * listed unless its reading is a no; an uncertain one carries
 * `reading: 'uncertain'`.
 */
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import type { YesNoReading } from '@goodvibes-jev/judgment';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { apiRoutes, HANDLER_METHODS, handlerView, routeLineView, servesQuestion } from '../batteries/api-routes.js';
import { safeRead, walk } from './shared.js';
import type { ApiFramework, ApiRoute } from './schema.js';

const SITE = 'tools.inspect.api-routes';
const READ_CONCURRENCY = 8;

type ConcreteFramework = Exclude<ApiFramework, 'auto'>;
type RouteReading = 'listed' | 'uncertain' | 'dismissed';

/** A yes lists the route, a no dismisses it, anything else lists it as uncertain. */
function routeReading(reading: YesNoReading): RouteReading {
  if (reading.verdict === 'yes') return 'listed';
  return reading.verdict === 'no' ? 'dismissed' : 'uncertain';
}

function route(method: string, path: string, file: string, line: number, reading: Exclude<RouteReading, 'dismissed'>): ApiRoute {
  return reading === 'uncertain' ? { method, path, file, line, reading } : { method, path, file, line };
}

async function findNextjsAppRoutes(root: string): Promise<ApiRoute[]> {
  const routes: ApiRoute[] = [];
  const appDir = join(root, 'app');
  if (!existsSync(appDir)) return routes;

  const files = await walk(appDir, (p) => p.endsWith('route.ts') || p.endsWith('route.js'));
  for (const file of files) {
    const content = safeRead(file);
    const relFile = relative(root, file);
    const lines = content.split('\n');
    const routePath = '/' + relative(join(root, 'app'), file)
      .replace(/\/route\.[tj]s$/, '')
      .replace(/\[(.+?)\]/g, ':$1')
      .replace(/\((.+?)\)\//g, '') || '/';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const method of HANDLER_METHODS) {
        if (
          line.match(new RegExp(`export\\s+(async\\s+)?function\\s+${method}\\b`)) ||
          line.match(new RegExp(`export\\s+const\\s+${method}\\s*=`))
        ) {
          routes.push({ method, path: routePath, file: relFile, line: i + 1 });
        }
      }
    }
  }
  return routes;
}

/** Each pages/api handler is read once for all seven methods (one request); each method it serves is a route. */
async function findNextjsPagesRoutes(root: string): Promise<ApiRoute[]> {
  const apiDir = join(root, 'pages', 'api');
  if (!existsSync(apiDir)) return [];

  const files = await walk(apiDir, (p) => /\.[tj]sx?$/.test(p));
  const perFile = await mapWithConcurrency(files, READ_CONCURRENCY, async (file) => {
    const relFile = relative(root, file);
    const routePath = '/' + relative(join(root, 'pages'), file)
      .replace(/\.[tj]sx?$/, '')
      .replace(/\[(.+?)\]/g, ':$1');
    const run = await apiRoutes.run(judgmentPort(SITE), handlerView(relFile, safeRead(file)), { site: SITE, only: HANDLER_METHODS.map(servesQuestion) });
    const routes = HANDLER_METHODS.flatMap((method) => {
      const reading = routeReading(run.readings[servesQuestion(method)]);
      return reading === 'dismissed' ? [] : [route(method, routePath, relFile, 1, reading)];
    });
    run.recordAction(`${relFile}: ${routes.map((r) => r.method).join(', ') || 'no methods'}`);
    return routes;
  });
  return perFile.flat();
}

/**
 * A candidate is a call of a method named after an HTTP verb whose first
 * argument is a string literal followed by another argument (or by the end
 * of the line, the arguments continuing below): the shape of a route
 * registration in Express, Fastify and Hono (path, then handlers).
 */
const VERB_CALL = /\.(get|post|put|delete|patch|options|head)\s*\(\s*(['"`])(.*?)\2\s*(?:,|$)/;

/** Verb calls read by `route_registration` for one framework; each is a route unless the reading is a no. */
async function findCallRoutes(root: string, framework: ConcreteFramework): Promise<ApiRoute[]> {
  const files = await walk(root, (p) => /\.[tj]sx?$/.test(p));
  const candidates = files.flatMap((file) => {
    const relFile = relative(root, file);
    const lines = safeRead(file).split('\n');
    return lines.flatMap((text, index) => {
      const m = VERB_CALL.exec(text);
      return m ? [{ relFile, lines, index, method: m[1]!.toUpperCase(), path: m[3] || '/' }] : [];
    });
  });
  const readings = await mapWithConcurrency(candidates, READ_CONCURRENCY, async ({ relFile, lines, index }) => {
    const run = await apiRoutes.run(judgmentPort(SITE), routeLineView(framework, relFile, lines, index), { site: SITE, only: ['route_registration'] });
    const reading = routeReading(run.readings.route_registration);
    run.recordAction(`${relFile}:${index + 1} ${framework}: ${reading}`);
    return reading;
  });
  return candidates.flatMap(({ relFile, index, method, path }, i) => {
    const reading = readings[i]!;
    return reading === 'dismissed' ? [] : [route(method, path, relFile, index + 1, reading)];
  });
}

const FRAMEWORK_PACKAGES: ReadonlyArray<readonly [pkg: string, framework: ConcreteFramework]> = [
  ['next', 'nextjs'],
  ['fastify', 'fastify'],
  ['hono', 'hono'],
  ['express', 'express'],
];

/** The API frameworks package.json declares as dependencies (facts, no preference among them). */
export function declaredApiFrameworks(root: string): ConcreteFramework[] {
  const raw = safeRead(join(root, 'package.json'));
  if (!raw) return [];
  try {
    const pkg = JSON.parse(raw);
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    return FRAMEWORK_PACKAGES.filter(([name]) => all[name]).map(([, framework]) => framework);
  } catch {
    return [];
  }
}

async function routesFor(root: string, framework: ConcreteFramework): Promise<ApiRoute[]> {
  if (framework === 'nextjs') return [...await findNextjsAppRoutes(root), ...await findNextjsPagesRoutes(root)];
  return findCallRoutes(root, framework);
}

/**
 * Routes of the given framework, or for 'auto' the routes of every framework
 * package.json declares; with none declared, every framework is scanned.
 * Each framework's candidates are read for that framework, so nothing is
 * preferred.
 */
export async function inspectApi(root: string, framework: ApiFramework): Promise<ApiRoute[]> {
  if (framework !== 'auto') return routesFor(root, framework);
  const declared = declaredApiFrameworks(root);
  const frameworks = declared.length > 0 ? declared : FRAMEWORK_PACKAGES.map(([, fw]) => fw);
  const routes: ApiRoute[] = [];
  for (const fw of frameworks) routes.push(...await routesFor(root, fw));
  return routes;
}
