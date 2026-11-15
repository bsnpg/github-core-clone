// graphql.ts — the GitHub GraphQL v4 surface at POST /api/graphql.
//
// A small, dependency-free executor for the documents gh and github-mcp-server
// actually send (see program/env/src/checks-graphql.ts): viewer, repository,
// node(id:), search, the __type/__schema probes, and the createIssue /
// closeIssue / createPullRequest / mergePullRequest / addComment mutations.
//
// A GraphQL-level failure is an HTTP 200 whose body carries `errors` (and
// `data: null`); it is not an HTTP error. An unauthenticated request is a 401.
// Two operation documents in one JSON-array body answer two bodies in order.
// Global ids are opaque (`R<repo>`, `I<repo>-<n>`, `P<repo>-<n>`, `C<...>`) and
// stable across reads; a repository lookup for an unknown owner/name answers
// `data.repository = null` with no errors.

import { parseCommit } from './gitproto.ts';
import { Store, VIEWER, type IssueRecord, type PullRecord, type RepoRecord } from './store.ts';

// ---------------------------------------------------------------------------------------------
// a small GraphQL document parser (the subset the suite sends)
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof'; value: '' };

function tokenize(document: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < document.length) {
    const ch = document[i] as string;
    if (/\s/.test(ch) || ch === ',') {
      // Commas are insignificant whitespace in GraphQL.
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < document.length && document[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < document.length && document[i] !== '"') {
        if (document[i] === '\\' && i + 1 < document.length) {
          const escaped = document[i + 1] as string;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          i += 2;
        } else {
          value += document[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(document[i + 1] ?? ''))) {
      let value = '';
      while (i < document.length && /[0-9.]/.test(document[i] as string)) {
        value += document[i];
        i += 1;
      }
      tokens.push({ kind: 'int', value });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let value = '';
      while (i < document.length && /[A-Za-z0-9_]/.test(document[i] as string)) {
        value += document[i];
        i += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    if ('{}()[]:!=@$&|.'.includes(ch)) {
      if (ch === '.' && document.slice(i, i + 3) === '...') {
        tokens.push({ kind: 'punct', value: '...' });
        i += 3;
        continue;
      }
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  alias: string | null;
  name: string;
  arguments: Array<{ name: string; value: Value }>;
  selectionSet: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inlineFragment'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation' | 'subscription';
  name: string | null;
  selectionSet: SelectionNode[];
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(document: string) {
    this.tokens = tokenize(document);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}" in GraphQL document`);
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const type = token.value as 'query' | 'mutation' | 'subscription';
        this.next();
        let name: string | null = null;
        const next = this.peek();
        if (next.kind === 'name') name = this.next().value as string;
        // Variable definitions, if any: ( $x: Type = default, ... ) — skipped.
        if (this.acceptPunct('(')) {
          let depth = 1;
          while (depth > 0) {
            const tok = this.next();
            if (tok.kind === 'eof') throw new Error('unterminated variable definitions');
            if (tok.kind === 'punct' && tok.value === '(') depth += 1;
            if (tok.kind === 'punct' && tok.value === ')') depth -= 1;
          }
        }
        operations.push({ type, name, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        this.expectName();
        if (this.peek().kind === 'name' && this.peek().value === 'on') this.next();
        this.expectName();
        this.parseSelectionSet();
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(token)} in GraphQL document`);
    }
    return operations;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        const name = this.next().value as string;
        return { kind: 'fragmentSpread', name };
      }
      return { kind: 'inlineFragment', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    const name = this.expectName();
    let alias: string | null = null;
    let fieldName = name;
    if (this.acceptPunct(':')) {
      alias = name;
      fieldName = this.expectName();
    }
    const args: Array<{ name: string; value: Value }> = [];
    if (this.acceptPunct('(')) {
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    let selectionSet: SelectionNode[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', field: { alias, name: fieldName, arguments: args, selectionSet } };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: Value[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

// ---------------------------------------------------------------------------------------------
// the schema the executor knows (field names only — the introspection probes read these)
// ---------------------------------------------------------------------------------------------

const SCHEMA: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'user', 'createdAt', 'updatedAt'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'user'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  Ref: ['name'],
  Node: ['id'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
  __Schema: ['types', 'queryType', 'mutationType'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'ORGANIZATION', 'PROJECT', 'TEAM', 'WIKI', 'TOPIC'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

const TYPE_KINDS: Record<string, string> = {
  Query: 'OBJECT',
  Mutation: 'OBJECT',
  User: 'OBJECT',
  Repository: 'OBJECT',
  Issue: 'OBJECT',
  IssueConnection: 'OBJECT',
  PullRequest: 'OBJECT',
  PullRequestConnection: 'OBJECT',
  PullRequestChangedFile: 'OBJECT',
  PageInfo: 'OBJECT',
  Ref: 'OBJECT',
  Node: 'INTERFACE',
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
  MergeableState: 'ENUM',
  PullRequestMergeMethod: 'ENUM',
  RepositoryPermission: 'ENUM',
  IssueOrderField: 'ENUM',
  OrderDirection: 'ENUM',
  __Type: 'OBJECT',
  __Field: 'OBJECT',
  __EnumValue: 'OBJECT',
  __Schema: 'OBJECT',
  String: 'SCALAR',
  Int: 'SCALAR',
  ID: 'SCALAR',
  Boolean: 'SCALAR',
};

// ---------------------------------------------------------------------------------------------
// the executor
// ---------------------------------------------------------------------------------------------

type RuntimeValue =
  | null
  | string
  | number
  | boolean
  | { __type: 'user' }
  | { __type: 'repo'; repo: RepoRecord }
  | { __type: 'issue'; repo: RepoRecord; issue: IssueRecord }
  | { __type: 'pull'; repo: RepoRecord; pull: PullRecord }
  | { __type: 'issuesConnection'; repo: RepoRecord; issues: IssueRecord[]; hasNextPage: boolean; endCursor: string | null }
  | { __type: 'pullsConnection'; repo: RepoRecord; pulls: PullRecord[] }
  | { __type: 'filesConnection'; repo: RepoRecord; pull: PullRecord }
  | { __type: 'ref'; name: string }
  | { __type: 'pageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __type: 'type'; name: string }
  | { __type: 'schema' };

class GraphQLError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolve a parsed value against the operation's variables. */
function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
      return value.value;
    case 'int':
      return value.value;
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((entry) => resolveValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, variables: Record<string, unknown>): unknown {
  const arg = field.arguments.find((candidate) => candidate.name === name);
  if (!arg) return undefined;
  return resolveValue(arg.value, variables);
}

function typeNameOf(value: RuntimeValue): string {
  if (value === null || typeof value !== 'object') return 'Scalar';
  switch (value.__type) {
    case 'user':
      return 'User';
    case 'repo':
      return 'Repository';
    case 'issue':
      return 'Issue';
    case 'pull':
      return 'PullRequest';
    case 'issuesConnection':
      return 'IssueConnection';
    case 'pullsConnection':
      return 'PullRequestConnection';
    case 'filesConnection':
      return 'PullRequestChangedFileConnection';
    case 'ref':
      return 'Ref';
    case 'pageInfo':
      return 'PageInfo';
    case 'type':
      return '__Type';
    case 'schema':
      return '__Schema';
  }
}

/** The cursor for an issue number: opaque, decodable by this executor only. */
function issueCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** Filter + sort + page a repository's issues the way the suite's queries ask. */
function issueConnection(store: Store, repo: RepoRecord, field: FieldNode, variables: Record<string, unknown>): { __type: 'issuesConnection'; repo: RepoRecord; issues: IssueRecord[]; hasNextPage: boolean; endCursor: string | null } {
  void store;
  let issues = [...repo.issues];
  const states = argValue(field, 'states', variables);
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state)));
    issues = issues.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = argValue(field, 'orderBy', variables);
  let direction: 'ASC' | 'DESC' = 'ASC';
  if (isRecord(orderBy)) {
    if (orderBy.direction === 'DESC') direction = 'DESC';
  }
  issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  const after = argValue(field, 'after', variables);
  const afterNumber = cursorNumber(after);
  if (afterNumber !== null) {
    const index = issues.findIndex((issue) => issue.number === afterNumber);
    if (index !== -1) issues = issues.slice(index + 1);
  }
  const first = argValue(field, 'first', variables);
  const page = typeof first === 'number' && Number.isFinite(first) ? issues.slice(0, Math.max(0, Math.trunc(first))) : issues;
  const hasNextPage = page.length > 0 && page.length < issues.length;
  const endCursor = page.length > 0 ? issueCursor(page[page.length - 1]?.number ?? 0) : null;
  return { __type: 'issuesConnection', repo, issues: page, hasNextPage, endCursor };
}

function pullState(pull: PullRecord): string {
  if (pull.state === 'open') return 'OPEN';
  return pull.merged ? 'MERGED' : 'CLOSED';
}

function mergeableState(store: Store, repo: RepoRecord, pull: PullRecord): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (baseTip === undefined) return 'UNKNOWN';
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  return store.mergeConflicts(repo, baseTip, headTip) ? 'CONFLICTING' : 'MERGEABLE';
}

class Executor {
  private readonly store: Store;
  private readonly variables: Record<string, unknown>;

  constructor(store: Store, variables: Record<string, unknown>) {
    this.store = store;
    this.variables = variables;
  }

  executeOperation(operation: OperationNode): Record<string, unknown> {
    const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
    return this.executeSelectionSet(operation.selectionSet, rootType, null);
  }

  private executeSelectionSet(selections: SelectionNode[], parentType: string, value: RuntimeValue): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'fragmentSpread') continue;
      if (selection.kind === 'inlineFragment') {
        if (selection.typeCondition !== null && selection.typeCondition !== parentType && selection.typeCondition !== 'Node') continue;
        Object.assign(out, this.executeSelectionSet(selection.selectionSet, parentType, value));
        continue;
      }
      const field = selection.field;
      const responseName = field.alias ?? field.name;
      out[responseName] = this.executeField(field, parentType, value);
    }
    return out;
  }

  private executeField(field: FieldNode, parentType: string, value: RuntimeValue): unknown {
    const allowed = SCHEMA[parentType];
    if (allowed === undefined || !allowed.includes(field.name)) {
      throw new GraphQLError(`Cannot query field "${field.name}" on type "${parentType}".`);
    }
    if (parentType === 'Query') return this.queryField(field);
    if (parentType === 'Mutation') return this.mutationField(field);
    if (parentType === '__Type') return this.typeField(field, value);
    if (parentType === '__Schema') return this.schemaField(field);
    if (parentType === 'Repository') return this.repositoryField(field, value as { __type: 'repo'; repo: RepoRecord });
    if (parentType === 'Issue') return this.issueField(field, value as { __type: 'issue'; repo: RepoRecord; issue: IssueRecord });
    if (parentType === 'PullRequest') return this.pullField(field, value as { __type: 'pull'; repo: RepoRecord; pull: PullRecord });
    if (parentType === 'User') return this.userField(field);
    if (parentType === 'IssueConnection' || parentType === 'PullRequestConnection') return this.connectionField(field, value);
    if (parentType === 'PullRequestChangedFileConnection') return this.filesConnectionField(field, value);
    if (parentType === 'PageInfo') return this.pageInfoField(field, value as { __type: 'pageInfo'; hasNextPage: boolean; endCursor: string | null });
    if (parentType === 'Ref') return (value as { __type: 'ref'; name: string }).name;
    if (parentType === 'Node') {
      if (field.name === 'id') return this.nodeId(value);
      return null;
    }
    if (parentType === 'PullRequestChangedFile') return this.changedFileField(field, value);
    return null;
  }

  private nodeId(value: RuntimeValue): string | null {
    if (value === null || typeof value !== 'object') return null;
    switch (value.__type) {
      case 'repo':
        return this.store.repoGlobalId(value.repo);
      case 'issue':
        return this.store.issueGlobalId(value.repo, value.issue);
      case 'pull':
        return this.store.pullGlobalId(value.repo, value.pull);
      default:
        return null;
    }
  }

  private queryField(field: FieldNode): unknown {
    if (field.name === 'viewer') {
      return this.executeSelectionSet(field.selectionSet, 'User', { __type: 'user' });
    }
    if (field.name === 'repository') {
      const owner = argValue(field, 'owner', this.variables);
      const name = argValue(field, 'name', this.variables);
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      const repo = this.store.getRepo(owner, name);
      if (!repo) return null;
      return this.executeSelectionSet(field.selectionSet, 'Repository', { __type: 'repo', repo });
    }
    if (field.name === 'node') {
      const id = argValue(field, 'id', this.variables);
      if (typeof id !== 'string') return null;
      const decoded = this.store.decodeGlobalId(id);
      if (!decoded) return null;
      let runtime: RuntimeValue;
      let typeName: string;
      if (decoded.kind === 'repo') {
        runtime = { __type: 'repo', repo: decoded.repo };
        typeName = 'Repository';
      } else if (decoded.kind === 'issue') {
        runtime = { __type: 'issue', repo: decoded.repo, issue: decoded.issue };
        typeName = 'Issue';
      } else if (decoded.kind === 'pull') {
        runtime = { __type: 'pull', repo: decoded.repo, pull: decoded.pull };
        typeName = 'PullRequest';
      } else {
        return null;
      }
      // `node` is the Node interface: `id` reads directly, the rest comes
      // through inline fragments on the concrete type.
      const out: Record<string, unknown> = {};
      for (const selection of field.selectionSet) {
        if (selection.kind === 'fragmentSpread') continue;
        if (selection.kind === 'inlineFragment') {
          if (selection.typeCondition !== null && selection.typeCondition !== typeName) continue;
          Object.assign(out, this.executeSelectionSet(selection.selectionSet, typeName, runtime));
          continue;
        }
        const sub = selection.field;
        if (sub.name === 'id') {
          out[sub.alias ?? 'id'] = this.nodeId(runtime);
          continue;
        }
        out[sub.alias ?? sub.name] = this.executeField(sub, typeName, runtime);
      }
      return out;
    }
    if (field.name === 'search') {
      const query = argValue(field, 'query', this.variables);
      const type = argValue(field, 'type', this.variables);
      const needle = typeof query === 'string' ? query.toLowerCase() : '';
      const matches: Array<{ __type: 'issue'; repo: RepoRecord; issue: IssueRecord }> = [];
      if (type === undefined || type === 'ISSUE') {
        for (const repo of this.store.listRepos(VIEWER.login)) {
          for (const issue of repo.issues) {
            if (issue.title.toLowerCase().includes(needle) || issue.body.toLowerCase().includes(needle)) {
              matches.push({ __type: 'issue', repo, issue });
            }
          }
        }
      }
      const first = argValue(field, 'first', this.variables);
      const sliced = typeof first === 'number' ? matches.slice(0, Math.max(0, Math.trunc(first))) : matches;
      const out: Record<string, unknown> = {};
      for (const selection of field.selectionSet) {
        if (selection.kind !== 'field') continue;
        const sub = selection.field;
        if (sub.name === 'nodes') {
          out[sub.alias ?? 'nodes'] = sliced.map((entry) => this.executeSelectionSet(sub.selectionSet, 'Issue', entry));
        } else if (sub.name === 'pageInfo') {
          out[sub.alias ?? 'pageInfo'] = this.executeSelectionSet(sub.selectionSet, 'PageInfo', { __type: 'pageInfo', hasNextPage: false, endCursor: null });
        } else if (sub.name === 'issueCount') {
          out[sub.alias ?? 'issueCount'] = matches.length;
        }
      }
      return out;
    }
    if (field.name === '__type') {
      const name = argValue(field, 'name', this.variables);
      if (typeof name !== 'string') return null;
      if (SCHEMA[name] === undefined && ENUM_VALUES[name] === undefined && TYPE_KINDS[name] === undefined) return null;
      return this.executeSelectionSet(field.selectionSet, '__Type', { __type: 'type', name });
    }
    if (field.name === '__schema') {
      return this.executeSelectionSet(field.selectionSet, '__Schema', { __type: 'schema' });
    }
    return null;
  }

  private typeField(field: FieldNode, value: RuntimeValue): unknown {
    const name = (value as { __type: 'type'; name: string }).name;
    if (field.name === 'name') return name;
    if (field.name === 'kind') return TYPE_KINDS[name] ?? 'OBJECT';
    if (field.name === 'description') return null;
    if (field.name === 'fields') {
      const names = SCHEMA[name] ?? [];
      return names.map((fieldName) => {
        const out: Record<string, unknown> = {};
        for (const selection of field.selectionSet) {
          if (selection.kind !== 'field') continue;
          const sub = selection.field;
          if (sub.name === 'name') out[sub.alias ?? 'name'] = fieldName;
          else if (sub.name === 'description') out[sub.alias ?? 'description'] = null;
          else if (sub.name === 'type') out[sub.alias ?? 'type'] = { name: 'String', kind: 'SCALAR' };
        }
        return out;
      });
    }
    if (field.name === 'enumValues') {
      const values = ENUM_VALUES[name] ?? [];
      return values.map((enumName) => {
        const out: Record<string, unknown> = {};
        for (const selection of field.selectionSet) {
          if (selection.kind !== 'field') continue;
          const sub = selection.field;
          if (sub.name === 'name') out[sub.alias ?? 'name'] = enumName;
          else if (sub.name === 'description') out[sub.alias ?? 'description'] = null;
        }
        return out;
      });
    }
    return null;
  }

  private schemaField(field: FieldNode): unknown {
    if (field.name === 'queryType') return { name: 'Query' };
    if (field.name === 'mutationType') return { name: 'Mutation' };
    if (field.name === 'types') {
      const names = Object.keys(TYPE_KINDS).sort();
      return names.map((typeName) => {
        const out: Record<string, unknown> = {};
        for (const selection of field.selectionSet) {
          if (selection.kind !== 'field') continue;
          const sub = selection.field;
          if (sub.name === 'name') out[sub.alias ?? 'name'] = typeName;
          else if (sub.name === 'kind') out[sub.alias ?? 'kind'] = TYPE_KINDS[typeName];
          else if (sub.name === 'description') out[sub.alias ?? 'description'] = null;
        }
        return out;
      });
    }
    return null;
  }

  private repositoryField(field: FieldNode, value: { __type: 'repo'; repo: RepoRecord }): unknown {
    const repo = value.repo;
    switch (field.name) {
      case 'id':
        return this.store.repoGlobalId(repo);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return this.executeSelectionSet(field.selectionSet, 'User', { __type: 'user' });
      case 'defaultBranchRef': {
        const sha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (sha === undefined) return null;
        return this.executeSelectionSet(field.selectionSet, 'Ref', { __type: 'ref', name: repo.defaultBranch });
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'issue': {
        const number = argValue(field, 'number', this.variables);
        if (typeof number !== 'number') return null;
        const issue = this.store.getIssue(repo, number);
        if (!issue) return null;
        return this.executeSelectionSet(field.selectionSet, 'Issue', { __type: 'issue', repo, issue });
      }
      case 'issues': {
        const connection = issueConnection(this.store, repo, field, this.variables);
        return this.executeSelectionSet(field.selectionSet, 'IssueConnection', connection);
      }
      case 'pullRequests': {
        let pulls = [...repo.pulls];
        const first = argValue(field, 'first', this.variables);
        if (typeof first === 'number') pulls = pulls.slice(0, Math.max(0, Math.trunc(first)));
        return this.executeSelectionSet(field.selectionSet, 'PullRequestConnection', { __type: 'pullsConnection', repo, pulls });
      }
      case 'pullRequest': {
        const number = argValue(field, 'number', this.variables);
        if (typeof number !== 'number') return null;
        const pull = this.store.getPull(repo, number);
        if (!pull) return null;
        return this.executeSelectionSet(field.selectionSet, 'PullRequest', { __type: 'pull', repo, pull });
      }
      default:
        return null;
    }
  }

  private issueField(field: FieldNode, value: { __type: 'issue'; repo: RepoRecord; issue: IssueRecord }): unknown {
    const issue = value.issue;
    switch (field.name) {
      case 'id':
        return this.store.issueGlobalId(value.repo, issue);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'body':
        return issue.body;
      case 'user':
        return this.executeSelectionSet(field.selectionSet, 'User', { __type: 'user' });
      case 'createdAt':
        return issue.createdAt;
      case 'updatedAt':
        return issue.updatedAt;
      default:
        return null;
    }
  }

  private pullField(field: FieldNode, value: { __type: 'pull'; repo: RepoRecord; pull: PullRecord }): unknown {
    const pull = value.pull;
    switch (field.name) {
      case 'id':
        return this.store.pullGlobalId(value.repo, pull);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pullState(pull);
      case 'merged':
        return pull.merged;
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'mergeable':
        return mergeableState(this.store, value.repo, pull);
      case 'files': {
        return this.executeSelectionSet(field.selectionSet, 'PullRequestChangedFileConnection', { __type: 'filesConnection', repo: value.repo, pull });
      }
      case 'user':
        return this.executeSelectionSet(field.selectionSet, 'User', { __type: 'user' });
      default:
        return null;
    }
  }

  private userField(field: FieldNode): unknown {
    switch (field.name) {
      case 'login':
        return VIEWER.login;
      case 'id':
        return VIEWER.id;
      case 'name':
        return VIEWER.name;
      case 'email':
        return VIEWER.email;
      default:
        return null;
    }
  }

  private connectionField(field: FieldNode, value: RuntimeValue): unknown {
    if (field.name === 'nodes') {
      if (value !== null && typeof value === 'object' && value.__type === 'issuesConnection') {
        return value.issues.map((issue) => this.executeSelectionSet(field.selectionSet, 'Issue', { __type: 'issue', repo: value.repo, issue }));
      }
      if (value !== null && typeof value === 'object' && value.__type === 'pullsConnection') {
        return value.pulls.map((pull) => this.executeSelectionSet(field.selectionSet, 'PullRequest', { __type: 'pull', repo: value.repo, pull }));
      }
      return [];
    }
    if (field.name === 'pageInfo') {
      let hasNextPage = false;
      let endCursor: string | null = null;
      if (value !== null && typeof value === 'object' && value.__type === 'issuesConnection') {
        hasNextPage = value.hasNextPage;
        endCursor = value.endCursor;
      }
      return this.executeSelectionSet(field.selectionSet, 'PageInfo', { __type: 'pageInfo', hasNextPage, endCursor });
    }
    if (field.name === 'totalCount') {
      if (value !== null && typeof value === 'object' && value.__type === 'issuesConnection') return value.repo.issues.length;
      if (value !== null && typeof value === 'object' && value.__type === 'pullsConnection') return value.repo.pulls.length;
      return 0;
    }
    return null;
  }

  private filesConnectionField(field: FieldNode, value: RuntimeValue): unknown {
    if (field.name !== 'nodes') return null;
    if (value === null || typeof value !== 'object' || value.__type !== 'filesConnection') return [];
    const { repo, pull } = value;
    const headCommit = repo.objects.get(pull.headSha);
    const baseCommit = repo.objects.get(pull.baseSha);
    if (!headCommit || !baseCommit) return [];
    const changes = this.store.diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
    const first = argValue(field, 'first', this.variables);
    const sliced = typeof first === 'number' ? changes.slice(0, Math.max(0, Math.trunc(first))) : changes;
    return sliced.map((change) =>
      this.executeSelectionSet(field.selectionSet, 'PullRequestChangedFile', change as unknown as RuntimeValue),
    );
  }

  private changedFileField(field: FieldNode, value: RuntimeValue): unknown {
    const change = value as unknown as { filename?: string; additions?: number; deletions?: number; status?: string };
    switch (field.name) {
      case 'path':
        return change.filename ?? '';
      case 'additions':
        return change.additions ?? 0;
      case 'deletions':
        return change.deletions ?? 0;
      case 'changeType':
        return change.status ?? '';
      default:
        return null;
    }
  }

  private pageInfoField(field: FieldNode, value: { __type: 'pageInfo'; hasNextPage: boolean; endCursor: string | null }): unknown {
    switch (field.name) {
      case 'hasNextPage':
        return value.hasNextPage;
      case 'hasPreviousPage':
        return false;
      case 'endCursor':
        return value.endCursor;
      case 'startCursor':
        return null;
      default:
        return null;
    }
  }

  /** A mutation payload: one field (issue / pullRequest) whose sub-selection runs against that type. */
  private executePayload(field: FieldNode, payloadField: 'issue' | 'pullRequest', value: RuntimeValue): unknown {
    const out: Record<string, unknown> = {};
    for (const selection of field.selectionSet) {
      if (selection.kind !== 'field') continue;
      const sub = selection.field;
      if (sub.name !== payloadField) continue;
      const typeName = payloadField === 'issue' ? 'Issue' : 'PullRequest';
      out[sub.alias ?? sub.name] = this.executeSelectionSet(sub.selectionSet, typeName, value);
    }
    return out;
  }

  private mutationField(field: FieldNode): unknown {
    const input = argValue(field, 'input', this.variables);
    if (!isRecord(input)) throw new GraphQLError(`mutation ${field.name} needs an input object`);
    if (field.name === 'createIssue') {
      const repositoryId = input.repositoryId;
      if (typeof repositoryId !== 'string') throw new GraphQLError('createIssue needs repositoryId');
      const decoded = this.store.decodeGlobalId(repositoryId);
      if (!decoded || decoded.kind !== 'repo') throw new GraphQLError('createIssue: repository not found');
      const title = input.title;
      if (typeof title !== 'string' || title === '') throw new GraphQLError('createIssue needs a title');
      const body = typeof input.body === 'string' ? input.body : '';
      const created = this.store.createIssue(decoded.repo, { title, body, labels: [] });
      if ('error' in created) throw new GraphQLError(created.error);
      return this.executePayload(field, 'issue', { __type: 'issue', repo: decoded.repo, issue: created });
    }
    if (field.name === 'closeIssue') {
      const issueId = input.issueId;
      if (typeof issueId !== 'string') throw new GraphQLError('closeIssue needs issueId');
      const decoded = this.store.decodeGlobalId(issueId);
      if (!decoded || decoded.kind !== 'issue') throw new GraphQLError('closeIssue: issue not found');
      decoded.issue.state = 'closed';
      return this.executePayload(field, 'issue', { __type: 'issue', repo: decoded.repo, issue: decoded.issue });
    }
    if (field.name === 'createPullRequest') {
      const repositoryId = input.repositoryId;
      if (typeof repositoryId !== 'string') throw new GraphQLError('createPullRequest needs repositoryId');
      const decoded = this.store.decodeGlobalId(repositoryId);
      if (!decoded || decoded.kind !== 'repo') throw new GraphQLError('createPullRequest: repository not found');
      const headRefName = input.headRefName;
      const baseRefName = input.baseRefName;
      const title = input.title;
      if (typeof headRefName !== 'string' || typeof baseRefName !== 'string' || typeof title !== 'string') {
        throw new GraphQLError('createPullRequest needs headRefName, baseRefName and title');
      }
      const body = typeof input.body === 'string' ? input.body : '';
      const created = this.store.createPull(decoded.repo, { title, body, head: headRefName, base: baseRefName });
      if ('error' in created) throw new GraphQLError(created.error);
      return this.executePayload(field, 'pullRequest', { __type: 'pull', repo: decoded.repo, pull: created });
    }
    if (field.name === 'mergePullRequest') {
      const pullRequestId = input.pullRequestId;
      if (typeof pullRequestId !== 'string') throw new GraphQLError('mergePullRequest needs pullRequestId');
      const decoded = this.store.decodeGlobalId(pullRequestId);
      if (!decoded || decoded.kind !== 'pull') throw new GraphQLError('mergePullRequest: pull request not found');
      const merged = this.store.mergePull(decoded.repo, decoded.pull);
      if ('error' in merged) throw new GraphQLError(merged.error);
      return this.executePayload(field, 'pullRequest', { __type: 'pull', repo: decoded.repo, pull: decoded.pull });
    }
    if (field.name === 'addComment') {
      const subjectId = input.subjectId;
      if (typeof subjectId !== 'string') throw new GraphQLError('addComment needs subjectId');
      const decoded = this.store.decodeGlobalId(subjectId);
      if (!decoded || decoded.kind !== 'issue') throw new GraphQLError('addComment: issue not found');
      const body = input.body;
      if (typeof body !== 'string') throw new GraphQLError('addComment needs body');
      const comment = this.store.createComment(decoded.repo, decoded.issue, body);
      const out: Record<string, unknown> = {};
      for (const selection of field.selectionSet) {
        if (selection.kind !== 'field') continue;
        const sub = selection.field;
        if (sub.name === 'commentEdge') {
          const edge: Record<string, unknown> = {};
          for (const edgeSelection of sub.selectionSet) {
            if (edgeSelection.kind !== 'field') continue;
            const nodeField = edgeSelection.field;
            if (nodeField.name === 'node') {
              const node: Record<string, unknown> = {};
              for (const nodeSelection of nodeField.selectionSet) {
                if (nodeSelection.kind !== 'field') continue;
                const leaf = nodeSelection.field;
                if (leaf.name === 'id') node[leaf.alias ?? 'id'] = this.store.commentGlobalId(decoded.repo, decoded.issue, comment);
                else if (leaf.name === 'body') node[leaf.alias ?? 'body'] = comment.body;
              }
              edge[nodeField.alias ?? 'node'] = node;
            }
          }
          out[sub.alias ?? 'commentEdge'] = edge;
        }
      }
      return out;
    }
    return null;
  }
}

/** Execute one operation document (or one entry of a batched body). */
function executeOne(store: Store, operation: unknown): Record<string, unknown> {
  if (!isRecord(operation) || typeof operation.query !== 'string') {
    return { data: null, errors: [{ message: 'a GraphQL operation needs a query string' }] };
  }
  const variables = isRecord(operation.variables) ? (operation.variables as Record<string, unknown>) : {};
  let operations: OperationNode[];
  try {
    operations = new Parser(operation.query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: `could not parse the query: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  if (operations.length === 0) {
    return { data: null, errors: [{ message: 'the query holds no operation' }] };
  }
  let chosen: OperationNode | undefined = operations[0];
  if (typeof operation.operationName === 'string') {
    chosen = operations.find((candidate) => candidate.name === operation.operationName);
    if (!chosen) return { data: null, errors: [{ message: `no operation named ${operation.operationName}` }] };
  }
  const executor = new Executor(store, variables);
  try {
    const data = executor.executeOperation(chosen as OperationNode);
    return { data, errors: [] };
  } catch (err) {
    if (err instanceof GraphQLError) {
      return { data: null, errors: [{ message: err.message }] };
    }
    return { data: null, errors: [{ message: `internal error: ${err instanceof Error ? err.message : String(err)}` }] };
  }
}

export interface GraphQLResult {
  status: number;
  body: unknown;
}

export function handleGraphQL(store: Store, body: unknown, authed: boolean): GraphQLResult {
  if (!authed) return { status: 401, body: { message: 'Requires authentication' } };
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((operation) => executeOne(store, operation)) };
  }
  return { status: 200, body: executeOne(store, body) };
}
