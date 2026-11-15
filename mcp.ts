// mcp.ts — the Model Context Protocol surface at POST /mcp (JSON-RPC 2.0,
// Streamable HTTP, answered as one JSON body per request; no SSE stream).
//
// The modern 2026-07-28 era: `server/discover` answers identity, capabilities
// and `supportedVersions` in one request; there is no handshake and no session.
// The legacy handshake (`initialize` + `notifications/initialized`) is also
// answered, so a pre-discover client still connects. Every request needs the
// bearer token (a missing token is a 401, decided before any tool exists).
//
// Errors: an unknown tool is JSON-RPC -32602 (never HTTP 500); a tool called
// without its required arguments answers `isError: true`; a body that is not
// JSON is HTTP 400 with JSON-RPC -32700. Two concurrent calls keep their own
// JSON-RPC ids (the request id is echoed verbatim), and two `tools/list`
// answers are byte-identical (the tool list is a constant).

import { Store, VIEWER, type RepoRecord } from './store.ts';
import { issueView, repoView } from './rest.ts';

export const MCP_REVISION = '2026-07-28';
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];
export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: readonly McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'The repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch.' },
        base: { type: 'string', description: 'The base branch.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonRpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function jsonRpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolResult(structured: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

/** The repository a tool call names, or null (the owner must be the viewer). */
function namedRepo(store: Store, args: Record<string, unknown>): RepoRecord | null {
  const owner = args.owner;
  const repo = args.repo;
  if (typeof owner !== 'string' || typeof repo !== 'string') return null;
  if (owner.toLowerCase() !== VIEWER.login) return null;
  return store.getRepo(owner, repo) ?? null;
}

function missingArgs(args: Record<string, unknown>, required: string[]): string | null {
  for (const name of required) {
    if (args[name] === undefined || args[name] === null || args[name] === '') return name;
  }
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const missing = missingArgs(args, ['name']);
      if (missing !== null) return toolError(`create_repo needs ${missing}`);
      const repoName = args.name as string;
      const description = typeof args.description === 'string' ? args.description : '';
      const priv = typeof args.private === 'boolean' ? args.private : false;
      const repo = store.createRepo(VIEWER.login, repoName, { description, private: priv });
      if (repo === null) return toolError(`repository ${repoName} already exists`);
      return toolResult(repoView(repo));
    }
    case 'get_repo': {
      const missing = missingArgs(args, ['owner', 'repo']);
      if (missing !== null) return toolError(`get_repo needs ${missing}`);
      const repo = namedRepo(store, args);
      if (!repo) return toolError('repository not found');
      return toolResult(repoView(repo));
    }
    case 'create_issue': {
      const missing = missingArgs(args, ['owner', 'repo', 'title']);
      if (missing !== null) return toolError(`create_issue needs ${missing}`);
      const repo = namedRepo(store, args);
      if (!repo) return toolError('repository not found');
      const created = store.createIssue(repo, {
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
        labels: [],
      });
      if ('error' in created) return toolError(created.error);
      return toolResult(issueView(created, repo));
    }
    case 'list_issues': {
      const missing = missingArgs(args, ['owner', 'repo']);
      if (missing !== null) return toolError(`list_issues needs ${missing}`);
      const repo = namedRepo(store, args);
      if (!repo) return toolError('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = state === 'all' ? repo.issues : repo.issues.filter((issue) => issue.state === state);
      return toolResult(issues.map((issue) => issueView(issue, repo)));
    }
    case 'create_pull_request': {
      const missing = missingArgs(args, ['owner', 'repo', 'title', 'head', 'base']);
      if (missing !== null) return toolError(`create_pull_request needs ${missing}`);
      const repo = namedRepo(store, args);
      if (!repo) return toolError('repository not found');
      const created = store.createPull(repo, {
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
        head: args.head as string,
        base: args.base as string,
      });
      if ('error' in created) return toolError(created.error);
      return toolResult({
        id: created.id,
        number: created.number,
        title: created.title,
        body: created.body,
        state: created.state,
        head: { ref: created.headRef, sha: created.headSha },
        base: { ref: created.baseRef, sha: created.baseSha },
      });
    }
    case 'merge_pull_request': {
      const missing = missingArgs(args, ['owner', 'repo', 'pull_number']);
      if (missing !== null) return toolError(`merge_pull_request needs ${missing}`);
      const repo = namedRepo(store, args);
      if (!repo) return toolError('repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      if (!Number.isInteger(number)) return toolError('merge_pull_request needs an integer pull_number');
      const pull = store.getPull(repo, number);
      if (!pull) return toolError('pull request not found');
      const merged = store.mergePull(repo, pull);
      if ('error' in merged) return toolError(merged.error);
      return toolResult({ number: pull.number, merged: true, sha: merged.sha, state: pull.state });
    }
    default:
      return toolError(`unknown tool ${name}`);
  }
}

export interface McpResult {
  status: number;
  body: unknown;
}

/**
 * Handle one POST /mcp body. `rawBody` is the request's bytes: a body that is
 * not JSON is answered HTTP 400 with JSON-RPC -32700. `authed` says whether
 * the bearer token was present and valid.
 */
export function handleMcp(store: Store, rawBody: Buffer, authed: boolean): McpResult {
  if (!authed) {
    return { status: 401, body: { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Requires authentication' } } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (!isRecord(parsed)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const id = parsed.id;
  const method = parsed.method;
  const params = isRecord(parsed.params) ? parsed.params : {};
  // A notification (no id) is acknowledged with an empty 202.
  if (id === undefined) {
    return { status: 202, body: '' };
  }
  if (typeof method !== 'string') {
    return { status: 200, body: jsonRpcError(id, -32600, 'Invalid Request') };
  }
  if (method === 'server/discover') {
    return {
      status: 200,
      body: jsonRpcResult(id, {
        resultType: 'DiscoverResult',
        supportedVersions: [...MCP_SUPPORTED_VERSIONS],
        capabilities: { tools: { listChanged: false } },
        instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP, GraphQL and MCP tools.',
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION } },
      }),
    };
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_REVISION;
    const negotiated = MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : MCP_REVISION;
    return {
      status: 200,
      body: jsonRpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      }),
    };
  }
  if (method === 'ping') {
    return { status: 200, body: jsonRpcResult(id, {}) };
  }
  if (method === 'tools/list') {
    return { status: 200, body: jsonRpcResult(id, { tools: TOOLS }) };
  }
  if (method === 'tools/call') {
    const toolName = params.name;
    if (typeof toolName !== 'string' || toolName === '') {
      return { status: 200, body: jsonRpcError(id, -32602, 'tools/call needs a tool name') };
    }
    const known = TOOLS.some((tool) => tool.name === toolName);
    if (!known) {
      return { status: 200, body: jsonRpcError(id, -32602, `unknown tool ${toolName}`) };
    }
    const args = isRecord(params.arguments) ? params.arguments : {};
    return { status: 200, body: jsonRpcResult(id, callTool(store, toolName, args)) };
  }
  return { status: 200, body: jsonRpcError(id, -32601, `Method not found: ${method}`) };
}
