// store.ts — the forge's whole state, in memory.
//
// One process, one Store. Repositories hold their own git objects and refs plus
// their issues, pull requests, labels and comments. Nothing here touches the
// disk, the network or the clock: all timestamps come from the trial's fixed
// "now", all ids from counters, so the same requests in the same order always
// build the same state.

import {
  buildCommit,
  buildTree,
  collectCommits,
  collectReachable,
  EMPTY_TREE_OID,
  flattenTree,
  hashObject,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTree,
  type CommitInfo,
  type GitObject,
  type GitObjectType,
} from './gitproto.ts';
import { TRIAL_NOW_EPOCH, TRIAL_NOW_ISO } from './util.ts';

/** The token owner's identity: the scenario's viewer (fixed by the kit's seed). */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** The git ident line every commit this forge authors carries. */
export function forgeIdent(): string {
  return `${VIEWER.name} <${VIEWER.email}> ${TRIAL_NOW_EPOCH} +0000`;
}

export interface LabelRecord {
  name: string;
  color: string;
  description: string;
}

export interface CommentRecord {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

export interface IssueRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
  comments: CommentRecord[];
  /**
   * The REST single-issue JSON body, cached as bytes: the read workload asks
   * for the same issue thousands of times and nothing about it changes
   * between reads. Cleared by any mutation of the issue (PATCH, new comment,
   * GraphQL closeIssue). The bytes are shared read-only — the dispatcher
   * copies them into each response, never mutates them.
   */
  viewBuf: Buffer | null;
}

export interface PullRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface RepoRecord {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, LabelRecord>;
  issues: IssueRecord[];
  pulls: PullRecord[];
  nextNumber: number;
  flatTreeCache: Map<string, Map<string, string>>;
  /** Issues and pulls by number: the single-item reads are O(1), not a scan. */
  issuesByNumber: Map<number, IssueRecord>;
  pullsByNumber: Map<number, PullRecord>;
}

export function repoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

/** One changed path between two trees, with line counts. */
export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  oldOid: string | null;
  newOid: string | null;
}

/** A line diff's added/removed counts, from an LCS over lines. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  if (oldText === newText) return { additions: 0, deletions: 0 };
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  // A trailing newline makes split() produce a final '' element on both sides;
  // drop it so "a\n" and "a" count as the same single line.
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  const n = a.length;
  const m = b.length;
  if (n === 0) return { additions: m, deletions: 0 };
  if (m === 0) return { additions: 0, deletions: n };
  // LCS lengths, two rows (contents here are small: blobs are a few KiB).
  let prev = new Array<number>(m + 1).fill(0);
  let cur = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
    cur.fill(0);
  }
  const lcs = prev[m] ?? 0;
  return { additions: m - lcs, deletions: n - lcs };
}

export class Store {
  readonly repos = new Map<string, RepoRecord>();
  private readonly reposById = new Map<number, RepoRecord>();
  private nextRepoId = 1;
  private nextObjectId = 1;
  private nextCommentId = 1;

  // -------------------------------------------------------------------------------------------
  // repositories
  // -------------------------------------------------------------------------------------------

  createRepo(owner: string, name: string, options: { description?: string; private?: boolean }): RepoRecord | null {
    const key = repoKey(owner, name);
    if (this.repos.has(key)) return null;
    const repo: RepoRecord = {
      id: this.nextRepoId++,
      owner: owner.toLowerCase(),
      name,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: 'main',
      createdAt: TRIAL_NOW_ISO,
      updatedAt: TRIAL_NOW_ISO,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      flatTreeCache: new Map(),
      issuesByNumber: new Map(),
      pullsByNumber: new Map(),
    };
    // The stock labels every GitHub repository starts with.
    for (const [label, color] of [
      ['bug', 'd73a4a'],
      ['enhancement', 'a2eeef'],
      ['documentation', '0075ca'],
      ['question', 'd876e3'],
      ['good first issue', '7057ff'],
      ['help wanted', '008672'],
    ] as const) {
      repo.labels.set(label, { name: label, color, description: '' });
    }
    this.repos.set(key, repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  getRepo(owner: string, name: string): RepoRecord | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.repos.get(repoKey(owner, name));
    if (repo) this.reposById.delete(repo.id);
    return this.repos.delete(repoKey(owner, name));
  }

  // -------------------------------------------------------------------------------------------
  // opaque Relay global ids (never the plain database id or the plain number)
  // -------------------------------------------------------------------------------------------

  repoGlobalId(repo: RepoRecord): string {
    return `R${repo.id}`;
  }

  issueGlobalId(repo: RepoRecord, issue: IssueRecord): string {
    return `I${repo.id}-${issue.number}`;
  }

  pullGlobalId(repo: RepoRecord, pull: PullRecord): string {
    return `P${repo.id}-${pull.number}`;
  }

  commentGlobalId(repo: RepoRecord, issue: IssueRecord, comment: CommentRecord): string {
    return `C${repo.id}-${issue.number}-${comment.id}`;
  }

  decodeGlobalId(
    id: string,
  ):
    | { kind: 'repo'; repo: RepoRecord }
    | { kind: 'issue'; repo: RepoRecord; issue: IssueRecord }
    | { kind: 'pull'; repo: RepoRecord; pull: PullRecord }
    | { kind: 'comment'; repo: RepoRecord; issue: IssueRecord; comment: CommentRecord }
    | null {
    const repoMatch = /^R(\d+)$/.exec(id);
    if (repoMatch) {
      const repo = this.reposById.get(Number(repoMatch[1]));
      return repo ? { kind: 'repo', repo } : null;
    }
    const issueMatch = /^I(\d+)-(\d+)$/.exec(id);
    if (issueMatch) {
      const repo = this.reposById.get(Number(issueMatch[1]));
      if (!repo) return null;
      const issue = this.getIssue(repo, Number(issueMatch[2]));
      return issue ? { kind: 'issue', repo, issue } : null;
    }
    const pullMatch = /^P(\d+)-(\d+)$/.exec(id);
    if (pullMatch) {
      const repo = this.reposById.get(Number(pullMatch[1]));
      if (!repo) return null;
      const pull = this.getPull(repo, Number(pullMatch[2]));
      return pull ? { kind: 'pull', repo, pull } : null;
    }
    const commentMatch = /^C(\d+)-(\d+)-(\d+)$/.exec(id);
    if (commentMatch) {
      const repo = this.reposById.get(Number(commentMatch[1]));
      if (!repo) return null;
      const issue = this.getIssue(repo, Number(commentMatch[2]));
      if (!issue) return null;
      const comment = issue.comments.find((candidate) => candidate.id === Number(commentMatch[3]));
      return comment ? { kind: 'comment', repo, issue, comment } : null;
    }
    return null;
  }

  listRepos(owner: string): RepoRecord[] {
    const lower = owner.toLowerCase();
    const out: RepoRecord[] = [];
    for (const repo of this.repos.values()) if (repo.owner === lower) out.push(repo);
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // git objects and refs
  // -------------------------------------------------------------------------------------------

  getObject(repo: RepoRecord, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  putObject(repo: RepoRecord, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  putObjects(repo: RepoRecord, objects: ReadonlyMap<string, GitObject>): void {
    for (const [oid, object] of objects) if (!repo.objects.has(oid)) repo.objects.set(oid, object);
  }

  lookup(repo: RepoRecord): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  /** Resolve a ref name, a branch name or a full oid to a commit oid (or null). */
  resolveRef(repo: RepoRecord, ref: string): string | null {
    if (/^[0-9a-f]{40}$/.test(ref)) return repo.objects.has(ref) ? ref : null;
    if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
    return repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`) ?? null;
  }

  /** The commit history reachable from `tip`, newest first. */
  commitHistory(repo: RepoRecord, tip: string): { sha: string; commit: CommitInfo }[] {
    const oids = collectCommits([tip], this.lookup(repo));
    const out: { sha: string; commit: CommitInfo }[] = [];
    for (const oid of oids) {
      const object = repo.objects.get(oid);
      if (object && object.type === 'commit') out.push({ sha: oid, commit: parseCommit(object.data) });
    }
    return out;
  }

  /** A tree's flat path map, cached per tree oid on the repo. */
  flatTree(repo: RepoRecord, treeOid: string): Map<string, string> {
    const cached = repo.flatTreeCache.get(treeOid);
    if (cached) return cached;
    const flat = flattenTree(treeOid, this.lookup(repo));
    repo.flatTreeCache.set(treeOid, flat);
    return flat;
  }

  /** Build (and store) the tree for a flat path map; returns the root tree oid. */
  buildTreeFromFlat(repo: RepoRecord, flat: ReadonlyMap<string, string>): string {
    // Group paths by directory, recursively. Only the directory names are
    // collected here — the recursion re-scans the flat map by prefix, so
    // building a per-directory sub-map would be work nobody reads.
    const build = (prefix: string): string => {
      const entries: { mode: string; name: string; oid: string }[] = [];
      const dirs = new Set<string>();
      for (const [path, oid] of flat) {
        if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
        const rest = prefix === '' ? path : path.slice(prefix.length + 1);
        const slash = rest.indexOf('/');
        if (slash === -1) {
          entries.push({ mode: '100644', name: rest, oid });
        } else {
          dirs.add(rest.slice(0, slash));
        }
      }
      for (const dir of dirs) {
        const subPrefix = prefix === '' ? dir : `${prefix}/${dir}`;
        entries.push({ mode: '40000', name: dir, oid: build(subPrefix) });
      }
      const data = buildTree(entries);
      return this.putObject(repo, 'tree', data);
    };
    if (flat.size === 0) {
      if (!repo.objects.has(EMPTY_TREE_OID)) repo.objects.set(EMPTY_TREE_OID, { type: 'tree', data: Buffer.alloc(0) });
      return EMPTY_TREE_OID;
    }
    return build('');
  }

  /** Create a commit on `branch` that sets `path` to `content` (or deletes it). */
  contentCommit(
    repo: RepoRecord,
    options: { branch: string; path: string; content: string | null; message: string },
  ): { commitSha: string; contentSha: string | null } | null {
    const refName = `refs/heads/${options.branch}`;
    const tip = repo.refs.get(refName);
    if (tip === undefined && repo.refs.has(`refs/heads/${options.branch}`) === false) {
      // An unborn branch: only the default branch may start a repository.
      if (options.branch !== repo.defaultBranch) return null;
    }
    let parentTreeOid = EMPTY_TREE_OID;
    const parents: string[] = [];
    if (tip !== undefined) {
      const commitObject = repo.objects.get(tip);
      if (!commitObject || commitObject.type !== 'commit') return null;
      parentTreeOid = parseCommit(commitObject.data).tree;
      parents.push(tip);
    }
    const flat = new Map(this.flatTree(repo, parentTreeOid));
    let contentSha: string | null = null;
    if (options.content === null) {
      if (!flat.has(options.path)) return null;
      flat.delete(options.path);
    } else {
      const blob = Buffer.from(options.content, 'utf8');
      contentSha = this.putObject(repo, 'blob', blob);
      flat.set(options.path, contentSha);
    }
    const treeOid = this.buildTreeFromFlat(repo, flat);
    const ident = forgeIdent();
    const commitData = buildCommit({ tree: treeOid, parents, message: options.message, author: ident, committer: ident });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(refName, commitSha);
    return { commitSha, contentSha };
  }

  // -------------------------------------------------------------------------------------------
  // diffs and merges
  // -------------------------------------------------------------------------------------------

  /** The file changes between two trees (base -> head). */
  diffTrees(repo: RepoRecord, baseTreeOid: string, headTreeOid: string): FileChange[] {
    const base = this.flatTree(repo, baseTreeOid);
    const head = this.flatTree(repo, headTreeOid);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const changes: FileChange[] = [];
    for (const path of [...paths].sort()) {
      const oldOid = base.get(path) ?? null;
      const newOid = head.get(path) ?? null;
      if (oldOid === newOid) continue;
      const oldText = oldOid === null ? '' : (repo.objects.get(oldOid)?.data.toString('utf8') ?? '');
      const newText = newOid === null ? '' : (repo.objects.get(newOid)?.data.toString('utf8') ?? '');
      const counts = lineDiff(oldText, newText);
      changes.push({
        filename: path,
        status: oldOid === null ? 'added' : newOid === null ? 'removed' : 'modified',
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
        oldOid,
        newOid,
      });
    }
    return changes;
  }

  /**
   * Whether merging `headSha` into `baseSha` conflicts (three-way, file granularity).
   * Callers that already walked the graph may hand in the merge base instead
   * of paying for the walk again; `undefined` means "work it out here".
   */
  mergeConflicts(repo: RepoRecord, baseSha: string, headSha: string, ancestor?: string | null): boolean {
    const baseCommit = repo.objects.get(baseSha);
    const headCommit = repo.objects.get(headSha);
    if (!baseCommit || !headCommit || baseCommit.type !== 'commit' || headCommit.type !== 'commit') return true;
    const baseTree = parseCommit(baseCommit.data).tree;
    const headTree = parseCommit(headCommit.data).tree;
    const ancestorOid = ancestor === undefined ? mergeBase(baseSha, headSha, this.lookup(repo)) : ancestor;
    const ancestorTree = ancestorOid === null ? EMPTY_TREE_OID : parseCommit(repo.objects.get(ancestorOid)?.data ?? Buffer.alloc(0)).tree;
    const baseFlat = this.flatTree(repo, baseTree);
    const headFlat = this.flatTree(repo, headTree);
    const ancestorFlat = ancestorOid === null ? new Map<string, string>() : this.flatTree(repo, ancestorTree);
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...ancestorFlat.keys()]);
    for (const path of paths) {
      const a = ancestorFlat.get(path) ?? null;
      const b = baseFlat.get(path) ?? null;
      const h = headFlat.get(path) ?? null;
      const baseChanged = b !== a;
      const headChanged = h !== a;
      if (baseChanged && headChanged && b !== h) return true;
    }
    return false;
  }

  /**
   * The merged flat tree for a squash merge of `headSha` onto `baseSha`
   * (null when it conflicts). Takes an already-known merge base like
   * mergeConflicts does, so one merge costs one graph walk, not three.
   */
  mergedFlat(repo: RepoRecord, baseSha: string, headSha: string, ancestor?: string | null): Map<string, string> | null {
    const ancestorOid = ancestor === undefined ? mergeBase(baseSha, headSha, this.lookup(repo)) : ancestor;
    if (this.mergeConflicts(repo, baseSha, headSha, ancestorOid)) return null;
    const baseCommit = repo.objects.get(baseSha);
    const headCommit = repo.objects.get(headSha);
    if (!baseCommit || !headCommit) return null;
    const ancestorTree = ancestorOid === null ? EMPTY_TREE_OID : parseCommit(repo.objects.get(ancestorOid)?.data ?? Buffer.alloc(0)).tree;
    const baseFlat = new Map(this.flatTree(repo, parseCommit(baseCommit.data).tree));
    const headFlat = this.flatTree(repo, parseCommit(headCommit.data).tree);
    const ancestorFlat = ancestorOid === null ? new Map<string, string>() : this.flatTree(repo, ancestorTree);
    for (const [path, h] of headFlat) {
      const a = ancestorFlat.get(path) ?? null;
      if (h !== a) baseFlat.set(path, h);
    }
    for (const [path, a] of ancestorFlat) {
      if (!headFlat.has(path) && baseFlat.get(path) === a) baseFlat.delete(path);
    }
    return baseFlat;
  }

  // -------------------------------------------------------------------------------------------
  // labels, issues, pull requests, comments
  // -------------------------------------------------------------------------------------------

  createLabel(repo: RepoRecord, name: string, color: string): LabelRecord {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const label: LabelRecord = { name, color: color || 'ededed', description: '' };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: RepoRecord, input: { title: string; body?: string; labels?: string[] }): IssueRecord | { error: string } {
    const labels: string[] = [];
    for (const name of input.labels ?? []) {
      if (!repo.labels.has(name)) return { error: `Label '${name}' does not exist` };
      labels.push(name);
    }
    const issue: IssueRecord = {
      id: this.nextObjectId++,
      number: repo.nextNumber++,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels,
      user: VIEWER.login,
      createdAt: TRIAL_NOW_ISO,
      updatedAt: TRIAL_NOW_ISO,
      comments: [],
      viewBuf: null,
    };
    repo.issues.push(issue);
    repo.issuesByNumber.set(issue.number, issue);
    return issue;
  }

  getIssue(repo: RepoRecord, number: number): IssueRecord | undefined {
    return repo.issuesByNumber.get(number);
  }

  createPull(
    repo: RepoRecord,
    input: { title: string; body?: string; head: string; base: string },
  ): PullRecord | { error: string } {
    const headSha = this.resolveRef(repo, input.head);
    const baseSha = this.resolveRef(repo, input.base);
    if (headSha === null) return { error: `Head branch '${input.head}' does not exist` };
    if (baseSha === null) return { error: `Base branch '${input.base}' does not exist` };
    const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === input.head && pull.baseRef === input.base);
    if (duplicate) return { error: 'A pull request already exists for this head and base' };
    const pull: PullRecord = {
      id: this.nextObjectId++,
      number: repo.nextNumber++,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: input.head,
      headSha,
      baseRef: input.base,
      baseSha,
      user: VIEWER.login,
      createdAt: TRIAL_NOW_ISO,
      updatedAt: TRIAL_NOW_ISO,
    };
    repo.pulls.push(pull);
    repo.pullsByNumber.set(pull.number, pull);
    return pull;
  }

  getPull(repo: RepoRecord, number: number): PullRecord | undefined {
    return repo.pullsByNumber.get(number);
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit sha or an error. */
  mergePull(repo: RepoRecord, pull: PullRecord): { sha: string } | { error: string; status: number } {
    if (pull.state !== 'open') return { error: 'Pull request is not open', status: 405 };
    const baseRefName = `refs/heads/${pull.baseRef}`;
    const baseTip = repo.refs.get(baseRefName);
    if (baseTip === undefined) return { error: 'Base branch does not exist', status: 422 };
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    // One graph walk for the whole merge: the base is found here and handed
    // down, instead of mergeConflicts and mergedFlat each walking it again.
    const ancestor = mergeBase(baseTip, headTip, this.lookup(repo));
    if (this.mergeConflicts(repo, baseTip, headTip, ancestor)) return { error: 'Merge conflict', status: 405 };
    const merged = this.mergedFlat(repo, baseTip, headTip, ancestor);
    if (merged === null) return { error: 'Merge conflict', status: 405 };
    const treeOid = this.buildTreeFromFlat(repo, merged);
    const ident = forgeIdent();
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
    const commitData = buildCommit({ tree: treeOid, parents: [baseTip], message, author: ident, committer: ident });
    const mergeSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(baseRefName, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = TRIAL_NOW_ISO;
    pull.mergeCommitSha = mergeSha;
    pull.updatedAt = TRIAL_NOW_ISO;
    return { sha: mergeSha };
  }

  createComment(repo: RepoRecord, issue: IssueRecord, body: string): CommentRecord {
    const comment: CommentRecord = {
      id: this.nextCommentId++,
      body,
      user: VIEWER.login,
      createdAt: TRIAL_NOW_ISO,
    };
    issue.comments.push(comment);
    issue.viewBuf = null;
    return comment;
  }

  /** All objects reachable from a set of roots (used by fetch). */
  reachable(repo: RepoRecord, roots: readonly string[]): Map<string, GitObject> {
    return collectReachable(roots, this.lookup(repo));
  }

  /** True when `ancestor` is reachable from `tip`. */
  isAncestor(repo: RepoRecord, ancestor: string, tip: string): boolean {
    return isAncestor(ancestor, tip, this.lookup(repo));
  }
}
