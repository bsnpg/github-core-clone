// rest.ts — the GitHub REST v3 surface under /api/v3.
//
// Every reply is application/json with a non-empty X-GitHub-Request-Id (the
// dispatcher adds both). Errors carry a JSON body with a string `message`.
// Unknown routes are JSON 404s, malformed JSON bodies are 400s, a missing
// bearer token is a 401, and a repository under any owner but the token's is
// a 404, never a 403.

import { parseCommit, parseTree, type GitObjectType } from './gitproto.ts';
import { Store, VIEWER, type CommentRecord, type IssueRecord, type PullRecord, type RepoRecord } from './store.ts';
import { b64decode, b64encodeBytes, TRIAL_NOW_ISO } from './util.ts';

export interface RestContext {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  bodyPresent: boolean;
  authed: boolean;
  baseUrl: string;
}

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** A pre-stringified JSON body: sent as-is, skipping a second stringify. A Buffer is sent as-is too. */
  raw?: string | Buffer;
}

function ok(body: unknown, status = 200, headers?: Record<string, string>): RestResult {
  return { status, body, headers };
}

function okRaw(raw: string | Buffer, status = 200, headers?: Record<string, string>): RestResult {
  return { status, body: null, headers, raw };
}

function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

/** The absolute URL of the request's path, for Link headers. */
function absoluteUrl(ctx: RestContext, path: string, query: Record<string, string | number>): string {
  const url = new URL(`${ctx.baseUrl}${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  return url.toString();
}

interface Page {
  items: unknown[];
  link: string | null;
}

/** Slice a list into a page and build GitHub's Link header when more pages exist. */
function paginate<T>(ctx: RestContext, path: string, all: readonly T[], view: (item: T) => unknown): Page {
  const perPageRaw = Number(ctx.query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.trunc(perPageRaw))) : 30;
  const pageRaw = Number(ctx.query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
  const start = (page - 1) * perPage;
  const slice = all.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(all.length / perPage));
  const links: string[] = [];
  const keepQuery = (): Record<string, string | number> => {
    const out: Record<string, string | number> = {};
    for (const [key, value] of ctx.query) if (key !== 'page' && key !== 'per_page') out[key] = value;
    out.per_page = perPage;
    return out;
  };
  if (page < totalPages) {
    links.push(`<${absoluteUrl(ctx, path, { ...keepQuery(), page: page + 1 })}>; rel="next"`);
    links.push(`<${absoluteUrl(ctx, path, { ...keepQuery(), page: totalPages })}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${absoluteUrl(ctx, path, { ...keepQuery(), page: 1 })}>; rel="first"`);
    links.push(`<${absoluteUrl(ctx, path, { ...keepQuery(), page: page - 1 })}>; rel="prev"`);
  }
  return { items: slice.map(view), link: links.length > 0 ? links.join(', ') : null };
}

function pageHeaders(page: Page): Record<string, string> | undefined {
  return page.link === null ? undefined : { link: page.link };
}

// ---------------------------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------------------------

export function repoView(repo: RepoRecord): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function labelView(label: { name: string; color: string; description: string }): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description };
}

export function issueView(issue: IssueRecord, repo: RepoRecord): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelView(label) : { name, color: 'ededed', description: '' };
    }),
    user: { login: issue.user, id: VIEWER.id, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/** The single-issue JSON body, cached on the issue as bytes (see store.ts viewBuf). */
export function issueViewBuf(issue: IssueRecord, repo: RepoRecord): Buffer {
  if (issue.viewBuf !== null) return issue.viewBuf;
  const buf = Buffer.from(JSON.stringify(issueView(issue, repo)), 'utf8');
  issue.viewBuf = buf;
  return buf;
}

function pullView(pull: PullRecord, repo: RepoRecord, store: Store): Record<string, unknown> {
  const head = {
    ref: pull.headRef,
    sha: pull.headSha,
    label: `${repo.owner}:${pull.headRef}`,
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
  };
  const base = {
    ref: pull.baseRef,
    sha: pull.baseSha,
    label: `${repo.owner}:${pull.baseRef}`,
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
  };
  let mergeable = false;
  if (pull.state === 'open') {
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    mergeable = baseTip !== undefined && !store.mergeConflicts(repo, baseTip, headTip);
  }
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable,
    head,
    base,
    user: { login: pull.user, id: VIEWER.id, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commentView(comment: CommentRecord): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: comment.user, id: VIEWER.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(body: unknown, field: string): string | undefined {
  if (!isRecord(body)) return undefined;
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

function boolField(body: unknown, field: string): boolean | undefined {
  if (!isRecord(body)) return undefined;
  const value = body[field];
  return typeof value === 'boolean' ? value : undefined;
}

/** The repository a route names, or the 404 result for it (owner must be the viewer). */
function namedRepo(store: Store, owner: string, name: string): RepoRecord | RestResult {
  if (owner.toLowerCase() !== VIEWER.login) return err(404, 'Not Found');
  const repo = store.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  return repo;
}

function isRepoResult(value: RepoRecord | RestResult): value is RestResult {
  return 'status' in value && 'body' in value;
}

// ---------------------------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------------------------

export function handleRest(store: Store, ctx: RestContext): RestResult {
  const [first, second, third, ...rest] = ctx.segments;

  // The API root and meta are public; everything else needs the token.
  if (ctx.segments.length === 0 && ctx.method === 'GET') {
    return ok(
      { current_user_url: `${ctx.baseUrl}/api/v3/user`, rate_limit_url: `${ctx.baseUrl}/api/v3/rate_limit` },
      200,
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  if (first === 'meta' && ctx.segments.length === 1 && ctx.method === 'GET') {
    return ok({ installed_version: '1.0.0' });
  }
  if (!ctx.authed) return err(401, 'Requires authentication');

  if (first === 'user') {
    if (second === undefined && ctx.method === 'GET') {
      return ok({ login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
    }
    if (second === 'repos') {
      if (ctx.method === 'POST') return createUserRepo(store, ctx);
      if (ctx.method === 'GET') {
        const repos = store.listRepos(VIEWER.login);
        const page = paginate(ctx, '/api/v3/user/repos', repos, (repo) => repoView(repo));
        return ok(page.items, 200, pageHeaders(page));
      }
    }
    return err(404, 'Not Found');
  }

  if (first === 'repos' && second !== undefined && third !== undefined) {
    const owner = decodeURIComponent(second);
    const name = decodeURIComponent(third);
    const sub = rest[0];
    if (sub === undefined) {
      if (ctx.method === 'GET') {
        const repo = namedRepo(store, owner, name);
        if (isRepoResult(repo)) return repo;
        return ok(repoView(repo));
      }
      if (ctx.method === 'PATCH') {
        const repo = namedRepo(store, owner, name);
        if (isRepoResult(repo)) return repo;
        if (isRecord(ctx.body)) {
          const description = stringField(ctx.body, 'description');
          if (description !== undefined) repo.description = description;
          const priv = boolField(ctx.body, 'private');
          if (priv !== undefined) repo.private = priv;
          repo.updatedAt = TRIAL_NOW_ISO;
        }
        return ok(repoView(repo));
      }
      if (ctx.method === 'DELETE') {
        const repo = namedRepo(store, owner, name);
        if (isRepoResult(repo)) return repo;
        store.deleteRepo(owner, name);
        return { status: 204, body: '' };
      }
      return err(404, 'Not Found');
    }
    if (sub === 'branches') {
      const repo = namedRepo(store, owner, name);
      if (isRepoResult(repo)) return repo;
      const branch = rest[1];
      if (branch === undefined && ctx.method === 'GET') {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .map((ref) => ref.slice('refs/heads/'.length))
          .sort();
        return ok(
          branches.map((branchName) => ({
            name: branchName,
            commit: { sha: repo.refs.get(`refs/heads/${branchName}`) ?? '' },
            protected: false,
          })),
        );
      }
      if (branch !== undefined && ctx.method === 'GET') {
        const sha = repo.refs.get(`refs/heads/${decodeURIComponent(branch)}`);
        if (sha === undefined) return err(404, 'Branch not found');
        return ok({ name: decodeURIComponent(branch), commit: { sha }, protected: false });
      }
      return err(404, 'Not Found');
    }
    if (sub === 'commits' && ctx.method === 'GET') {
      const repo = namedRepo(store, owner, name);
      if (isRepoResult(repo)) return repo;
      const ref = ctx.query.get('sha') ?? repo.defaultBranch;
      const tip = store.resolveRef(repo, ref);
      if (tip === null) return err(404, 'No commit found for this ref');
      const history = store.commitHistory(repo, tip);
      return ok(
        history.map(({ sha, commit }) => ({
          sha,
          commit: {
            message: commit.message,
            author: identView(commit.author),
            committer: identView(commit.committer),
          },
          parents: commit.parents.map((parent) => ({ sha: parent })),
        })),
      );
    }
    if (sub === 'git' && rest[1] === 'refs') {
      const repo = namedRepo(store, owner, name);
      if (isRepoResult(repo)) return repo;
      if (ctx.method === 'POST') {
        const ref = stringField(ctx.body, 'ref');
        const sha = stringField(ctx.body, 'sha');
        if (ref === undefined || sha === undefined) return err(422, 'ref and sha are required');
        if (!ref.startsWith('refs/')) return err(422, 'ref must start with refs/');
        if (!repo.objects.has(sha)) return err(422, 'Object does not exist');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        return ok({ ref, object: { sha, type: 'commit' } }, 201);
      }
      if (ctx.method === 'GET' && rest.length >= 3) {
        const refName = `refs/${rest.slice(2).map(decodeURIComponent).join('/')}`;
        const sha = repo.refs.get(refName);
        if (sha === undefined) return err(404, 'Not Found');
        return ok({ ref: refName, object: { sha, type: 'commit' } });
      }
      return err(404, 'Not Found');
    }
    if (sub === 'contents') {
      const repo = namedRepo(store, owner, name);
      if (isRepoResult(repo)) return repo;
      const path = rest.slice(1).map(decodeURIComponent).join('/');
      if (ctx.method === 'GET') return getContents(store, ctx, repo, path);
      if (ctx.method === 'PUT') return putContents(store, ctx, repo, path);
      if (ctx.method === 'DELETE') return deleteContents(store, ctx, repo, path);
      return err(404, 'Not Found');
    }
    if (sub === 'labels') {
      const repo = namedRepo(store, owner, name);
      if (isRepoResult(repo)) return repo;
      if (ctx.method === 'POST') {
        const labelName = stringField(ctx.body, 'name');
        if (labelName === undefined || labelName === '') return err(422, 'name is required');
        const color = stringField(ctx.body, 'color') ?? 'ededed';
        return ok(labelView(store.createLabel(repo, labelName, color)), 201);
      }
      if (ctx.method === 'GET') {
        return ok([...repo.labels.values()].map(labelView));
      }
      return err(404, 'Not Found');
    }
    if (sub === 'issues') {
      const repo = namedRepo(store, owner, name);
      if (isRepoResult(repo)) return repo;
      const number = rest[1];
      if (number === undefined) {
        if (ctx.method === 'POST') return createIssue(store, ctx, repo);
        if (ctx.method === 'GET') return listIssues(ctx, repo);
        return err(404, 'Not Found');
      }
      const issueNumber = Number(number);
      if (!Number.isInteger(issueNumber)) return err(404, 'Not Found');
      const issue = store.getIssue(repo, issueNumber);
      if (rest[2] === 'comments') {
        if (!issue) return err(404, 'Not Found');
        if (ctx.method === 'POST') {
          const body = stringField(ctx.body, 'body');
          if (body === undefined) return err(422, 'body is required');
          return ok(commentView(store.createComment(repo, issue, body)), 201);
        }
        if (ctx.method === 'GET') return ok(issue.comments.map(commentView));
        return err(404, 'Not Found');
      }
      if (rest.length > 2) return err(404, 'Not Found');
      if (!issue) return err(404, 'Not Found');
      if (ctx.method === 'GET') return okRaw(issueViewBuf(issue, repo));
      if (ctx.method === 'PATCH') {
        if (isRecord(ctx.body)) {
          const state = stringField(ctx.body, 'state');
          if (state === 'open' || state === 'closed') issue.state = state;
          const title = stringField(ctx.body, 'title');
          if (title !== undefined) issue.title = title;
          const body = stringField(ctx.body, 'body');
          if (body !== undefined) issue.body = body;
          issue.updatedAt = TRIAL_NOW_ISO;
          issue.viewBuf = null;
        }
        return ok(issueView(issue, repo));
      }
      return err(404, 'Not Found');
    }
    if (sub === 'pulls') {
      const repo = namedRepo(store, owner, name);
      if (isRepoResult(repo)) return repo;
      const number = rest[1];
      if (number === undefined) {
        if (ctx.method === 'POST') return createPull(store, ctx, repo);
        if (ctx.method === 'GET') return listPulls(store, ctx, repo);
        return err(404, 'Not Found');
      }
      const pullNumber = Number(number);
      if (!Number.isInteger(pullNumber)) return err(404, 'Not Found');
      const pull = store.getPull(repo, pullNumber);
      if (rest[2] === 'files') {
        if (!pull) return err(404, 'Not Found');
        if (ctx.method !== 'GET') return err(404, 'Not Found');
        const headCommit = repo.objects.get(pull.headSha);
        const baseCommit = repo.objects.get(pull.baseSha);
        if (!headCommit || !baseCommit) return err(422, 'Pull request commits are missing');
        const changes = store.diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
        return ok(
          changes.map((change) => ({
            filename: change.filename,
            status: change.status,
            additions: change.additions,
            deletions: change.deletions,
            changes: change.changes,
          })),
        );
      }
      if (rest[2] === 'merge') {
        if (!pull) return err(404, 'Not Found');
        if (ctx.method !== 'PUT') return err(404, 'Not Found');
        const merged = store.mergePull(repo, pull);
        if ('error' in merged) return err(merged.status, merged.error);
        return ok({ sha: merged.sha, merged: true, message: `Pull request #${pull.number} merged (squash)` });
      }
      if (rest.length > 2) return err(404, 'Not Found');
      if (!pull) return err(404, 'Not Found');
      if (ctx.method === 'GET') return ok(pullView(pull, repo, store));
      return err(404, 'Not Found');
    }
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// repositories
// ---------------------------------------------------------------------------------------------

function createUserRepo(store: Store, ctx: RestContext): RestResult {
  const name = stringField(ctx.body, 'name');
  if (name === undefined || name === '') return err(422, 'name is required');
  const description = stringField(ctx.body, 'description') ?? '';
  const priv = boolField(ctx.body, 'private') ?? false;
  const repo = store.createRepo(VIEWER.login, name, { description, private: priv });
  if (repo === null) return err(422, 'Repository already exists');
  return ok(repoView(repo), 201);
}

// ---------------------------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------------------------

function createIssue(store: Store, ctx: RestContext, repo: RepoRecord): RestResult {
  const title = stringField(ctx.body, 'title');
  if (title === undefined || title === '') return err(422, 'title is required');
  const body = stringField(ctx.body, 'body') ?? '';
  const labels = isRecord(ctx.body) && Array.isArray(ctx.body.labels) ? (ctx.body.labels as unknown[]).filter((label): label is string => typeof label === 'string') : [];
  const created = store.createIssue(repo, { title, body, labels });
  if ('error' in created) return err(422, created.error);
  return ok(issueView(created, repo), 201);
}

function listIssues(ctx: RestContext, repo: RepoRecord): RestResult {
  const state = ctx.query.get('state') ?? 'open';
  const sort = ctx.query.get('sort') ?? 'created';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = repo.issues;
  if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
  const sorted = [...issues];
  if (sort === 'created') {
    sorted.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  }
  const path = `/api/v3/repos/${repo.owner}/${repo.name}/issues`;
  const page = paginate(ctx, path, sorted, (issue) => issueView(issue, repo));
  return ok(page.items, 200, pageHeaders(page));
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

function createPull(store: Store, ctx: RestContext, repo: RepoRecord): RestResult {
  const title = stringField(ctx.body, 'title');
  const head = stringField(ctx.body, 'head');
  const base = stringField(ctx.body, 'base');
  if (title === undefined || head === undefined || base === undefined) return err(422, 'title, head and base are required');
  const body = stringField(ctx.body, 'body') ?? '';
  const created = store.createPull(repo, { title, body, head, base });
  if ('error' in created) return err(422, created.error);
  return ok(pullView(created, repo, store), 201);
}

function listPulls(store: Store, ctx: RestContext, repo: RepoRecord): RestResult {
  const state = ctx.query.get('state') ?? 'open';
  let pulls = repo.pulls;
  if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
  const path = `/api/v3/repos/${repo.owner}/${repo.name}/pulls`;
  const page = paginate(ctx, path, pulls, (pull) => pullView(pull, repo, store));
  return ok(page.items, 200, pageHeaders(page));
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

/** The commit a ref names, or null when the repo has no commit there. */
function refTipCommit(store: Store, repo: RepoRecord, ref: string | null): { sha: string; tree: string } | null {
  const tip = ref === null ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : store.resolveRef(repo, ref);
  if (tip === undefined || tip === null) return null;
  const object = repo.objects.get(tip);
  if (!object || object.type !== 'commit') return null;
  return { sha: tip, tree: parseCommit(object.data).tree };
}

function walkPath(store: Store, repo: RepoRecord, treeOid: string, segments: string[]): { oid: string; type: GitObjectType } | null {
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) {
      const target = repo.objects.get(entry.oid);
      if (!target) return null;
      return { oid: entry.oid, type: target.type };
    }
    current = entry.oid;
  }
  return null;
}

function getContents(store: Store, ctx: RestContext, repo: RepoRecord, path: string): RestResult {
  const tip = refTipCommit(store, repo, ctx.query.get('ref'));
  if (tip === null) return err(404, 'Not Found');
  const segments = path === '' ? [] : path.split('/');
  if (segments.length === 0) {
    const entries = dirEntries(store, repo, tip.tree, '');
    return ok(entries);
  }
  const found = walkPath(store, repo, tip.tree, segments);
  if (found === null) return err(404, 'Not Found');
  if (found.type === 'blob') {
    const blob = repo.objects.get(found.oid);
    if (!blob) return err(404, 'Not Found');
    return ok({
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: segments[segments.length - 1] ?? '',
      path,
      content: b64encodeBytes(blob.data),
      sha: found.oid,
    });
  }
  if (found.type === 'tree') {
    return ok(dirEntries(store, repo, found.oid, path));
  }
  return err(404, 'Not Found');
}

function dirEntries(store: Store, repo: RepoRecord, treeOid: string, dirPath: string): Array<Record<string, unknown>> {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return [];
  return parseTree(object.data).map((entry) => {
    const childPath = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
    const isDir = entry.mode === '40000';
    const child = repo.objects.get(entry.oid);
    return {
      type: isDir ? 'dir' : 'file',
      name: entry.name,
      path: childPath,
      sha: entry.oid,
      size: isDir ? 0 : (child?.data.length ?? 0),
    };
  });
}

function putContents(store: Store, ctx: RestContext, repo: RepoRecord, path: string): RestResult {
  const message = stringField(ctx.body, 'message') ?? `Update ${path}`;
  const contentB64 = stringField(ctx.body, 'content');
  if (contentB64 === undefined) return err(422, 'content is required');
  const branch = stringField(ctx.body, 'branch') ?? repo.defaultBranch;
  const sha = stringField(ctx.body, 'sha');
  const tip = refTipCommit(store, repo, branch);
  if (tip === null && repo.refs.has(`refs/heads/${branch}`)) return err(404, 'Branch not found');
  if (tip === null && branch !== repo.defaultBranch) return err(404, 'Branch not found');
  const existed = tip !== null && walkPath(store, repo, tip.tree, path.split('/')) !== null;
  if (existed) {
    const current = walkPath(store, repo, tip.tree, path.split('/'));
    if (sha === undefined) return err(422, 'sha is required to update a file');
    if (current === null || current.oid !== sha) return err(409, 'sha does not match the current file');
  }
  const content = b64decode(contentB64).toString('utf8');
  const created = store.contentCommit(repo, { branch, path, content, message });
  if (created === null) return err(404, 'Branch not found');
  const name = path.split('/').pop() ?? path;
  return ok(
    {
      content: { name, path, sha: created.contentSha ?? '', size: Buffer.byteLength(content, 'utf8'), encoding: 'base64', type: 'file' },
      commit: { sha: created.commitSha, message },
    },
    existed ? 200 : 201,
  );
}

function deleteContents(store: Store, ctx: RestContext, repo: RepoRecord, path: string): RestResult {
  const message = stringField(ctx.body, 'message') ?? `Delete ${path}`;
  const branch = stringField(ctx.body, 'branch') ?? repo.defaultBranch;
  const sha = stringField(ctx.body, 'sha');
  const tip = refTipCommit(store, repo, branch);
  if (tip === null) return err(404, 'Not Found');
  const current = walkPath(store, repo, tip.tree, path.split('/'));
  if (current === null) return err(404, 'Not Found');
  if (sha !== undefined && current.oid !== sha) return err(409, 'sha does not match the current file');
  const deleted = store.contentCommit(repo, { branch, path, content: null, message });
  if (deleted === null) return err(404, 'Not Found');
  return ok({ commit: { sha: deleted.commitSha, message } });
}

// ---------------------------------------------------------------------------------------------
// small views
// ---------------------------------------------------------------------------------------------

function identView(ident: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(ident);
  if (!match) return { name: ident, email: '', date: TRIAL_NOW_ISO };
  return { name: match[1] ?? '', email: match[2] ?? '', date: new Date(Number(match[3]) * 1000).toISOString() };
}
