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
//
// Transport: a bare node:net server with a hand-rolled HTTP/1.1 reader, not
// node:http. The suite's workloads are thousands of small sequential requests
// on keep-alive connections, and the HTTP stack's per-request machinery
// (IncomingMessage / ServerResponse objects, stream events, chunked framing)
// is a measurable share of each round trip. The reader below does one parse
// and one write per request: request line + headers, a Content-Length body
// (chunked bodies are decoded too, for safety), pipelined requests on one
// socket answered in order, keep-alive by default. Every handler runs
// synchronously once a whole request is buffered, so responses never reorder.

import { createServer, type Server, type Socket } from 'node:net';
import { handleUploadPack, handleReceivePack, handleInfoRefs, type GitRequest } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestResult } from './rest.ts';
import { Store } from './store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

interface DispatchResult {
  status: number;
  contentType: string;
  body: Buffer;
  extraHeaders?: Record<string, string>;
}

function jsonResult(status: number, body: unknown, extraHeaders?: Record<string, string>): DispatchResult {
  return { status, contentType: 'application/json', body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'), extraHeaders };
}

function bufferResult(status: number, body: Buffer, contentType: string, extraHeaders?: Record<string, string>): DispatchResult {
  return { status, contentType, body, extraHeaders };
}

function restResult(result: RestResult, requestId: string): DispatchResult {
  const text = result.raw !== undefined ? result.raw : JSON.stringify(result.body);
  return {
    status: result.status,
    contentType: 'application/json',
    // A cached Buffer body is sent as-is; a string body is encoded once here.
    body: typeof text === 'string' ? Buffer.from(text, 'utf8') : text,
    extraHeaders: { 'x-github-request-id': requestId, ...(result.headers ?? {}) },
  };
}

/** Decode a path segment only when it actually carries an escape. */
function decodeSegment(value: string): string {
  return value.includes('%') ? decodeURIComponent(value) : value;
}

function bearerToken(headers: Record<string, string>): string | null {
  const header = headers.authorization;
  if (header === undefined) return null;
  const trimmed = header.trim();
  if (!trimmed.startsWith('Bearer ')) return null;
  return trimmed.slice('Bearer '.length);
}

function authed(headers: Record<string, string>): boolean {
  const token = bearerToken(headers);
  if (token === null || token === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected === undefined || expected === '') return true;
  return token === expected;
}

/**
 * Route one fully-buffered request. `target` is the raw request target
 * (origin-form `/path?query`); `body` is the raw request body (empty for a
 * bodyless GET, exactly as the wire carried it).
 */
function dispatch(
  store: Store,
  requestId: string,
  method: string,
  target: string,
  headers: Record<string, string>,
  body: Buffer,
): DispatchResult {
  const question = target.indexOf('?');
  const rawPath = question === -1 ? target : target.slice(0, question);
  const queryString = question === -1 ? '' : target.slice(question + 1);
  // Absolute-form targets (a client talking through a proxy) carry the
  // origin in front; the suite never sends them, but strip it defensively.
  const pathname = rawPath.startsWith('http://') || rawPath.startsWith('https://')
    ? rawPath.slice(rawPath.indexOf('/', rawPath.indexOf('://') + 3))
    : rawPath;
  const segments: string[] = [];
  for (const part of pathname.split('/')) if (part !== '') segments.push(part);
  // The query string is parsed only on the routes that read it (REST and the
  // git info/refs advertisement); health, MCP, GraphQL and the git POSTs
  // never touch it, so building the parser on every request is pure waste.
  let query: URLSearchParams | null = null;
  const getQuery = (): URLSearchParams => (query ??= new URLSearchParams(queryString));

  if (method === 'GET' && pathname === '/healthz') {
    return jsonResult(200, { ok: true });
  }

  if (pathname === '/mcp') {
    if (method !== 'POST') return jsonResult(405, { message: 'Method Not Allowed' });
    const result = handleMcp(store, body, authed(headers));
    return jsonResult(result.status, result.body);
  }

  if (pathname === '/api/graphql') {
    if (method !== 'POST') return jsonResult(405, { message: 'Method Not Allowed' });
    if (!authed(headers)) return jsonResult(401, { message: 'Requires authentication' });
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8')) as unknown;
    } catch {
      return jsonResult(400, { message: 'Invalid JSON' });
    }
    const result = handleGraphQL(store, parsed, true);
    return jsonResult(result.status, result.body);
  }

  if (segments[0] === 'api' && segments[1] === 'v3') {
    // The base URL is only needed by REST handlers (Link headers), so it is
    // built here, not on every request.
    const baseUrl = `http://${headers.host ?? 'localhost'}`;
    if (method === 'GET' && segments.length === 2) {
      const result = handleRest(store, {
        method,
        segments: [],
        query: getQuery(),
        body: undefined,
        bodyPresent: false,
        authed: authed(headers),
        baseUrl,
      });
      return restResult(result, requestId);
    }
    let parsed: unknown;
    const bodyPresent = body.length > 0;
    if (!bodyPresent) {
      parsed = undefined;
    } else {
      try {
        parsed = JSON.parse(body.toString('utf8')) as unknown;
      } catch {
        return jsonResult(400, { message: 'Invalid JSON' }, { 'x-github-request-id': requestId });
      }
    }
    const result = handleRest(store, {
      method,
      segments: segments.slice(2),
      query: getQuery(),
      body: parsed,
      bodyPresent,
      authed: authed(headers),
      baseUrl,
    });
    return restResult(result, requestId);
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (segments.length >= 2 && segments[1]?.endsWith('.git') === true) {
    const owner = decodeSegment(segments[0] as string);
    const repo = decodeSegment((segments[1] as string).slice(0, -'.git'.length));
    const tail = segments.slice(2);
    if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
      const service = getQuery().get('service');
      if (service === 'git-upload-pack' || service === 'git-receive-pack') {
        const result = handleInfoRefs(store, { owner, repo, service, query: getQuery(), headers, body: Buffer.alloc(0) });
        return bufferResult(result.status, result.body, result.contentType);
      }
      return jsonResult(400, { message: 'service is required' });
    }
    if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
      const result = handleUploadPack(store, { owner, repo, service: 'git-upload-pack', query: getQuery(), headers, body });
      return bufferResult(result.status, result.body, result.contentType);
    }
    if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
      const result = handleReceivePack(store, { owner, repo, service: 'git-receive-pack', query: getQuery(), headers, body });
      return bufferResult(result.status, result.body, result.contentType);
    }
    return jsonResult(404, { message: 'Not Found' });
  }

  return jsonResult(404, { message: 'Not Found' });
}

// ---------------------------------------------------------------------------------------------
// the raw HTTP/1.1 reader
// ---------------------------------------------------------------------------------------------

interface ParsedRequest {
  method: string;
  target: string;
  headers: Record<string, string>;
  body: Buffer;
  /** Bytes consumed from the socket buffer by this request. */
  consumed: number;
  closeAfter: boolean;
}

/**
 * Parse one request out of `buf`. Returns null when more bytes are needed,
 * or throws on a malformed request line / headers. A chunked body is decoded
 * into one buffer; a Content-Length body is sliced as-is.
 */
function parseRequest(buf: Buffer): ParsedRequest | null {
  const headerEnd = buf.indexOf('\r\n\r\n');
  if (headerEnd === -1) {
    if (buf.length > MAX_HEADER_BYTES) throw new Error('request headers too large');
    return null;
  }
  const head = buf.subarray(0, headerEnd).toString('latin1');
  const lines = head.split('\r\n');
  const requestLine = lines[0] ?? '';
  const parts = requestLine.split(' ');
  if (parts.length !== 3 || parts[0] === '' || parts[1] === '' || !/^HTTP\/\d\.\d$/.test(parts[2] as string)) {
    throw new Error('malformed request line');
  }
  const [method, target, version] = parts as [string, string, string];
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const colon = line.indexOf(':');
    if (colon === -1) throw new Error('malformed header line');
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name !== '') headers[name] = value;
  }
  const bodyStart = headerEnd + 4;
  const transferEncoding = headers['transfer-encoding'] ?? '';
  const connection = headers.connection ?? '';
  const closeAfter =
    connection.toLowerCase().includes('close') || (version === 'HTTP/1.0' && !connection.toLowerCase().includes('keep-alive'));
  if (transferEncoding.toLowerCase().includes('chunked')) {
    // Decode chunked framing; every chunk size line and trailer is ASCII.
    let at = bodyStart;
    const chunks: Buffer[] = [];
    for (;;) {
      const lineEnd = buf.indexOf('\r\n', at);
      if (lineEnd === -1) return null;
      const sizeText = buf.subarray(at, lineEnd).toString('ascii').split(';')[0]?.trim() ?? '';
      const size = parseInt(sizeText, 16);
      if (!Number.isFinite(size) || size < 0) throw new Error('malformed chunk size');
      const dataStart = lineEnd + 2;
      if (size === 0) {
        // Trailer headers, if any, end at the next blank line.
        const trailerEnd = buf.indexOf('\r\n\r\n', dataStart);
        const end = trailerEnd === -1 ? dataStart + 2 : trailerEnd + 4;
        if (buf.length < end) return null;
        return { method, target, headers, body: Buffer.concat(chunks), consumed: end, closeAfter };
      }
      if (buf.length < dataStart + size + 2) return null;
      if (buf[dataStart + size] !== 0x0d || buf[dataStart + size + 1] !== 0x0a) throw new Error('malformed chunk framing');
      chunks.push(buf.subarray(dataStart, dataStart + size));
      at = dataStart + size + 2;
    }
  }
  const lengthText = headers['content-length'];
  if (lengthText === undefined) {
    return { method, target, headers, body: Buffer.alloc(0), consumed: bodyStart, closeAfter };
  }
  const length = Number(lengthText);
  if (!Number.isInteger(length) || length < 0) throw new Error('malformed content-length');
  if (length > MAX_BODY_BYTES) throw new Error('request body too large');
  if (buf.length < bodyStart + length) return null;
  return { method, target, headers, body: buf.subarray(bodyStart, bodyStart + length), consumed: bodyStart + length, closeAfter };
}

/** Serialise one response: status line, headers, Content-Length, body. */
function buildResponse(result: DispatchResult): Buffer {
  const isEmpty = result.status === 204 || result.status === 304;
  const body = isEmpty ? Buffer.alloc(0) : result.body;
  const reason = REASONS[result.status] ?? '';
  const lines: string[] = [`HTTP/1.1 ${result.status} ${reason}`, `content-type: ${result.contentType}`, `content-length: ${body.length}`];
  for (const [name, value] of Object.entries(result.extraHeaders ?? {})) lines.push(`${name}: ${value}`);
  const head = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
  return body.length === 0 ? head : Buffer.concat([head, body]);
}

export function createApp(store: Store = new Store()): Server {
  let requestCounter = 0;
  const server = createServer((socket: Socket) => {
    socket.setNoDelay(true);
    let pending = Buffer.alloc(0);
    let destroyed = false;
    const fail = (status: number, message: string): void => {
      if (destroyed) return;
      try {
        socket.write(buildResponse(jsonResult(status, { message })));
      } catch {
        // The socket is already gone; nothing left to answer.
      }
      socket.destroy();
      destroyed = true;
    };
    socket.on('data', (chunk: Buffer) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      for (;;) {
        let request: ParsedRequest | null;
        try {
          request = parseRequest(pending);
        } catch {
          fail(400, 'malformed request');
          return;
        }
        if (request === null) return;
        pending = pending.subarray(request.consumed);
        // Answer an Expect: 100-continue before the handler runs.
        if ((request.headers.expect ?? '').toLowerCase() === '100-continue') {
          socket.write(Buffer.from('HTTP/1.1 100 Continue\r\n\r\n', 'latin1'));
        }
        const requestId = `req-${(requestCounter += 1)}`;
        let result: DispatchResult;
        try {
          result = dispatch(store, requestId, request.method, request.target, request.headers, request.body);
        } catch (err) {
          result = jsonResult(500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        }
        try {
          socket.write(buildResponse(result));
        } catch {
          socket.destroy();
          destroyed = true;
          return;
        }
        if (request.closeAfter) {
          socket.end();
          return;
        }
      }
    });
    socket.on('error', () => {
      destroyed = true;
    });
  });
  return server;
}
