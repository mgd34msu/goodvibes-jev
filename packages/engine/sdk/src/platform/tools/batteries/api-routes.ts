/**
 * `engine.tools.api-routes`: the readings behind inspect modes `api`,
 * `api_spec`, `api_validate` and `api_sync` (tools/inspect/project-routes.ts)
 * where syntax alone does not say what a route is.
 *
 * - `route_registration` (one candidate line): does this call register an
 *   HTTP route handler with the named framework (Express, Fastify or Hono)?
 *   Code finds the candidates from syntax: a call of a method named after an
 *   HTTP verb whose first argument is a string literal followed by more
 *   arguments, which is the shape of a route registration in all three
 *   frameworks. Replaces deciding by the receiver's name (router, app or
 *   server for Express, fastify for Fastify, app for Hono).
 * - `serves_get` ... `serves_options` (one Next.js pages/api handler, the
 *   seven questions in one request): does the handler serve requests of this
 *   method? Replaces recording every such handler as method ANY, which the
 *   spec generator then wrote as GET only and the spec validator never
 *   compared.
 *
 * Band: low stakes. The routes are an inspection report and a draft spec;
 * nothing runs on them. Code lists a route unless the reading is a no, and
 * marks one whose reading is uncertain.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

/** Lines of context carried on each side of a candidate route line. */
export const ROUTE_CONTEXT_LINES = 3;
/** Most characters of a pages/api handler file the method readings carry. */
export const MAX_HANDLER_CHARS = 24_000;

/** The HTTP methods a pages/api handler is read for, in the order they are reported. */
export const HANDLER_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HandlerMethod = (typeof HANDLER_METHODS)[number];
export type ServesQuestion = `serves_${Lowercase<HandlerMethod>}`;
export const servesQuestion = (method: HandlerMethod): ServesQuestion => `serves_${method.toLowerCase() as Lowercase<HandlerMethod>}`;

/** What the route_registration reading sees: the framework asked about, the file's import lines, the candidate line and the lines around it. */
export function routeLineView(framework: string, file: string, lines: readonly string[], index: number): { framework: string; file: string; imports: string[]; line: string; before: string[]; after: string[] } {
  return {
    framework,
    file,
    imports: lines.filter((line) => /^\s*import\b|\brequire\s*\(/.test(line)),
    line: lines[index] ?? '',
    before: lines.slice(Math.max(0, index - ROUTE_CONTEXT_LINES), index),
    after: lines.slice(index + 1, index + 1 + ROUTE_CONTEXT_LINES),
  };
}

/** What the method readings see: the handler file, up to MAX_HANDLER_CHARS. */
export function handlerView(file: string, content: string): { file: string; code: string } {
  return { file, code: content.length <= MAX_HANDLER_CHARS ? content : content.slice(0, MAX_HANDLER_CHARS) };
}

const LOW = STAKES_BANDS.low.yesNo;

const serves = (method: HandlerMethod) =>
  yesNo(
    `\`code\` is a Next.js pages API route handler from \`file\`. Does the handler serve ${method} requests: answer them with a real response rather than reject them (for example with a 405 Method Not Allowed)? A handler that never checks the request method serves every method.`,
    LOW,
  );

const line = (framework: string, file: string, code: string, index: number) => routeLineView(framework, file, code.split('\n'), index);
const expectAll = (verdict: 'yes' | 'no', except: Partial<Record<HandlerMethod, 'yes' | 'no'>> = {}) =>
  Object.fromEntries(HANDLER_METHODS.map((method) => [servesQuestion(method), except[method] ?? verdict])) as Record<ServesQuestion, 'yes' | 'no'>;

const EXPRESS_ROUTER = [
  "import { Router } from 'express';",
  "import { requireAuth } from '../auth.js';",
  '',
  'export const users = Router();',
  '',
  "users.get('/users/:id', requireAuth, async (req, res) => {",
  '  res.json(await db.user.findUnique({ where: { id: req.params.id } }));',
  '});',
].join('\n');
const FASTIFY_PLUGIN = [
  "import type { FastifyInstance } from 'fastify';",
  '',
  'export default async function health(instance: FastifyInstance) {',
  "  instance.get('/health', { logLevel: 'warn' }, async () => ({ ok: true }));",
  '}',
].join('\n');
const HONO_APP = [
  "import { Hono } from 'hono';",
  '',
  'const api = new Hono();',
  "api.post('/posts', async (c) => c.json(await createPost(await c.req.json()), 201));",
  'export default api;',
].join('\n');
const CACHE_LOOKUP = [
  "import { LRUCache } from 'lru-cache';",
  "import express from 'express';",
  '',
  'const app = express();',
  'const cache = new LRUCache({ max: 500 });',
  'export function cachedUsers() {',
  "  return cache.get('users', { allowStale: true });",
  '}',
].join('\n');
const AXIOS_CALL = [
  "import axios from 'axios';",
  "import { useEffect, useState } from 'react';",
  '',
  'export function useUsers(page) {',
  '  const [users, setUsers] = useState([]);',
  "  useEffect(() => { axios.get('/api/users', { params: { page } }).then((r) => setUsers(r.data)); }, [page]);",
  '  return users;',
  '}',
].join('\n');
const EXPRESS_APP_ASKED_AS_HONO = [
  "import express from 'express';",
  '',
  'const app = express();',
  "app.get('/health', (req, res) => res.send('ok'));",
  'app.listen(3000);',
].join('\n');

const GET_ONLY = [
  "import type { NextApiRequest, NextApiResponse } from 'next';",
  '',
  'export default async function handler(req: NextApiRequest, res: NextApiResponse) {',
  "  if (req.method !== 'GET') {",
  "    res.setHeader('Allow', 'GET');",
  "    return res.status(405).end('Method Not Allowed');",
  '  }',
  '  res.status(200).json(await listProducts());',
  '}',
].join('\n');
const ANY_METHOD = [
  "import type { NextApiRequest, NextApiResponse } from 'next';",
  '',
  'export default function handler(req: NextApiRequest, res: NextApiResponse) {',
  "  res.status(200).json({ status: 'ok', time: Date.now() });",
  '}',
].join('\n');
const POST_AND_DELETE = [
  "import type { NextApiRequest, NextApiResponse } from 'next';",
  '',
  'export default async function handler(req: NextApiRequest, res: NextApiResponse) {',
  '  switch (req.method) {',
  "    case 'POST':",
  '      return res.status(201).json(await addToCart(req.body));',
  "    case 'DELETE':",
  '      await clearCart(req.query.id as string);',
  '      return res.status(204).end();',
  '    default:',
  "      res.setHeader('Allow', ['POST', 'DELETE']);",
  '      return res.status(405).end();',
  '  }',
  '}',
].join('\n');

export const apiRoutes = defineBattery({
  name: 'engine.tools.api-routes',
  version: 1,
  description: 'Whether a call registers an HTTP route with a given framework, and which HTTP methods a Next.js pages API handler serves.',
  accuracyFloor: 0.85,
  items: {
    route_registration: yesNo(
      '`line` (with the lines `before` and `after` it) from `file` calls a method named after an HTTP verb with a string first argument, and `imports` are the file\'s import lines. Does this line register an HTTP route handler with the `framework` web framework, on an app, router, plugin instance or server object from that framework? Calls with the same method name on anything else (a Map or cache, URLSearchParams, Headers, an HTTP client such as axios or supertest, or an app of a different framework) do not.',
      LOW,
    ),
    serves_get: serves('GET'),
    serves_post: serves('POST'),
    serves_put: serves('PUT'),
    serves_patch: serves('PATCH'),
    serves_delete: serves('DELETE'),
    serves_head: serves('HEAD'),
    serves_options: serves('OPTIONS'),
  },
  fixtures: [
    { name: 'express router route with middleware', state: line('express', 'src/routes/users.ts', EXPRESS_ROUTER, 5), expect: { route_registration: 'yes' } },
    { name: 'fastify plugin instance not named fastify', state: line('fastify', 'src/plugins/health.ts', FASTIFY_PLUGIN, 3), expect: { route_registration: 'yes' } },
    { name: 'hono app not named app', state: line('hono', 'src/api.ts', HONO_APP, 3), expect: { route_registration: 'yes' } },
    { name: 'cache lookup with options', state: line('express', 'src/cache.ts', CACHE_LOOKUP, 6), expect: { route_registration: 'no' } },
    { name: 'axios request in a react hook', state: line('express', 'src/hooks/useUsers.ts', AXIOS_CALL, 5), expect: { route_registration: 'no' } },
    { name: 'express app asked about hono', state: line('hono', 'server.js', EXPRESS_APP_ASKED_AS_HONO, 3), expect: { route_registration: 'no' } },
    { name: 'get only with a 405 for the rest', state: handlerView('pages/api/products.ts', GET_ONLY), expect: expectAll('no', { GET: 'yes' }) },
    { name: 'no method check serves every method', state: handlerView('pages/api/health.ts', ANY_METHOD), expect: expectAll('yes') },
    { name: 'post and delete by switch', state: handlerView('pages/api/cart.ts', POST_AND_DELETE), expect: { serves_get: 'no', serves_post: 'yes', serves_delete: 'yes', serves_put: 'no' } },
  ],
});
