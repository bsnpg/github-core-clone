// app.ts — the HTTP dispatcher: one server, one in-memory store per trial.
//
// Routes:
//   GET  /healthz                        -> 200 {"ok":true}
//   POST /mcp                            -> the MCP endpoint (JSON-RPC 2.0)
//   POST /api/graphql                    -> the GraphQL v4 endpoint
//   /api/v3/*                            -> the REST v3 surface (auth + JSON +
//                                           X-GitHub-Request-Id on every reply)
//   GET  /{owner}/{repo}.git/info/refs  -> git smart-HTTP advertisements
//   POST /{owner}/{repo}.git/git-upload-pack
//   POST /{owner}/{repo}.git/git-receive-pack
//   anything else                        -> 404 {"message":"Not Found"}
//
// Authentication: the trial's bearer token is MAKEFUN_SHOP_TOKEN. When it is
// set, only that token authenticates; when it is unset (local runs), any
// non-empty bearer token does. The request id is a per-process counter —
// deterministic, never a random UUID, and it never enters any exported state.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { handleUploadPack, handleReceivePack, handleInfoRefs, type GitRequest } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match ? (match[1] as string) : null;
}

function authed(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected === undefined || expected === '') return true;
  return token === expected;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...(extraHeaders ?? {}) });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, extraHeaders?: Record<string, string>): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...(extraHeaders ?? {}) });
  res.end(body);
}

export function createApp(store: Store = new Store()): ReturnType<typeof createServer> {
  let requestCounter = 0;
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const method = req.method ?? 'GET';
        const segments = url.pathname.split('/').filter((part) => part !== '');
        const requestId = `req-${(requestCounter += 1)}`;

        if (method === 'GET' && url.pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (url.pathname === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const body = await readBody(req);
          const result = handleMcp(store, body, authed(req));
          sendJson(res, result.status, result.body);
          return;
        }

        if (url.pathname === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const body = await readBody(req);
          if (!authed(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8')) as unknown;
          } catch {
            sendJson(res, 400, { message: 'Invalid JSON' });
            return;
          }
          const result = handleGraphQL(store, parsed, true);
          sendJson(res, result.status, result.body);
          return;
        }

        if (segments[0] === 'api' && segments[1] === 'v3') {
          if (method === 'GET' && segments.length === 2) {
            // The API root: public, answered by the REST router.
            const result = handleRest(store, {
              method,
              segments: [],
              query: url.searchParams,
              body: undefined,
              bodyPresent: false,
              authed: authed(req),
              baseUrl: `http://${req.headers.host ?? 'localhost'}`,
            });
            sendJson(res, result.status, result.body, { 'x-github-request-id': requestId, ...(result.headers ?? {}) });
            return;
          }
          const body = await readBody(req);
          let parsed: unknown;
          let bodyPresent = body.length > 0;
          if (!bodyPresent) {
            parsed = undefined;
          } else {
            try {
              parsed = JSON.parse(body.toString('utf8')) as unknown;
            } catch {
              sendJson(res, 400, { message: 'Invalid JSON' }, { 'x-github-request-id': requestId });
              return;
            }
          }
          const result = handleRest(store, {
            method,
            segments: segments.slice(2),
            query: url.searchParams,
            body: parsed,
            bodyPresent,
            authed: authed(req),
            baseUrl: `http://${req.headers.host ?? 'localhost'}`,
          });
          sendJson(res, result.status, result.body, { 'x-github-request-id': requestId, ...(result.headers ?? {}) });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        if (segments.length >= 2 && segments[1]?.endsWith('.git') === true) {
          const owner = decodeURIComponent(segments[0] as string);
          const repo = decodeURIComponent((segments[1] as string).slice(0, -'.git'.length));
          const tail = segments.slice(2);
          const headers = req.headers as Record<string, string | undefined>;
          if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
            const service = url.searchParams.get('service');
            if (service === 'git-upload-pack' || service === 'git-receive-pack') {
              const result = handleInfoRefs(store, { owner, repo, service, query: url.searchParams, headers, body: Buffer.alloc(0) });
              sendBuffer(res, result.status, result.body, result.contentType);
              return;
            }
            sendJson(res, 400, { message: 'service is required' });
            return;
          }
          if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
            const body = await readBody(req);
            const result = handleUploadPack(store, { owner, repo, service: 'git-upload-pack', query: url.searchParams, headers, body });
            sendBuffer(res, result.status, result.body, result.contentType);
            return;
          }
          if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
            const body = await readBody(req);
            const result = handleReceivePack(store, { owner, repo, service: 'git-receive-pack', query: url.searchParams, headers, body });
            sendBuffer(res, result.status, result.body, result.contentType);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } else {
          res.destroy();
        }
      }
    })();
  });
  return server;
}
