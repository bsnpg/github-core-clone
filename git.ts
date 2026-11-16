// git.ts — the git smart-HTTP surface: info/refs, upload-pack (protocol v2
// ls-refs/fetch, plus a v0 fetch fallback) and receive-pack (v0, report-status).
//
// The framing follows git's own wire rules: pkt-lines, section delimiters,
// side-band-64k for packs and reports, and fast-forward enforcement on pushes.

import {
  buildTree,
  collectReachable,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  flattenTree,
  isAncestor,
  parseCommit,
  parseTagTarget,
  parseTree,
  PKT_DELIM,
  PKT_FLUSH,
  readPack,
  writePack,
  type GitObject,
  type GitPacket,
} from './gitproto.ts';
import { Store, type RepoRecord } from './store.ts';
import { ZERO_OID } from './util.ts';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';
const AGENT = 'forge/1.0.0';

export interface GitRequest {
  owner: string;
  repo: string;
  service: 'git-upload-pack' | 'git-receive-pack' | null;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function jsonResponse(status: number, body: unknown): GitResponse {
  return { status, contentType: 'application/json', body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8') };
}

function sortedRefs(repo: RepoRecord): Array<{ name: string; oid: string }> {
  const refs: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) refs.push({ name, oid });
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

/** The peeled commit of an annotated tag ref, or null when the ref is not one. */
function peeledOid(repo: RepoRecord, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  return parseTagTarget(object.data).object;
}

/** The v2 capability advertisement. */
function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

/** The v0 advertisement for a service, with the ref list and capabilities. */
function v0Advertisement(repo: RepoRecord, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-receive-pack'
      ? `report-status side-band-64k delete-refs agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`
      : `side-band-64k agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch} object-format=sha1`;
  const preamble = encodePktLine(`# service=${service}\n`);
  const refs = sortedRefs(repo);
  const lines: Buffer[] = [preamble, PKT_FLUSH];
  if (refs.length === 0) {
    lines.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const headLine = mainTip === undefined ? null : `${mainTip} HEAD\0${caps}\n`;
    if (headLine !== null) lines.push(encodePktLine(headLine));
    for (const ref of refs) {
      lines.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== null) lines.push(encodePktLine(`${peeled} ${ref.name}^{}\n`));
    }
    if (headLine === null) {
      // No default branch yet: the capabilities ride the first ref line instead.
      const first = lines[2];
      if (first !== undefined) {
        const text = first.toString('utf8');
        lines[2] = encodePktLine(text.replace('\n', `\0${caps}\n`));
      }
    }
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(store: Store, req: GitRequest): GitResponse {
  const repo = store.getRepo(req.owner, req.repo);
  if (!repo || req.service === null) return jsonResponse(404, { message: 'Not Found' });
  if (req.service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2') {
    return { status: 200, contentType: UPLOAD_AD, body: v2Advertisement() };
  }
  const body = v0Advertisement(repo, req.service);
  return { status: 200, contentType: req.service === 'git-upload-pack' ? UPLOAD_AD : RECEIVE_AD, body };
}

// ---------------------------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(repo: RepoRecord, packets: GitPacket[]): Buffer {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (mainTip !== undefined) {
    if (keep('HEAD')) lines.push(`${mainTip} HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}`);
  } else if (args.unborn && keep('HEAD')) {
    lines.push(`unborn HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}`);
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel) {
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  const parts: Buffer[] = lines.map((line) => encodePktLine(`${line}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// fetch (v2 + v0)
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  /** The client sent `done`: it will not negotiate further, so the response must not open a negotiation. */
  done: boolean;
  /** A shallow fetch was requested (deepen / deepen-since / deepen-not). */
  shallowRequested: boolean;
}

function parseFetchArgs(packets: GitPacket[], v2: boolean): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false, shallowRequested: false };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const oid = rest.split(' ')[0] ?? '';
      if (/^[0-9a-f]{40}$/.test(oid)) args.wants.push(oid);
    } else if (line.startsWith('have ')) {
      args.haves.push(line.slice(5).trim());
    } else if (line.startsWith('shallow ')) {
      args.shallow.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isFinite(n)) args.depth = Math.trunc(n);
      args.shallowRequested = true;
    } else if (line.startsWith('deepen-since ') || line.startsWith('deepen-not ')) {
      args.shallowRequested = true;
    } else if (line === 'done') {
      args.done = true;
    }
    void v2;
  }
  return args;
}

interface FetchPlan {
  packObjects: GitObject[];
  /** The pack objects' oids, in the same order as packObjects (the pack-cache key). */
  packOids: string[];
  shallow: string[];
  unshallow: string[];
  wantedRefs: Array<{ oid: string; ref: string }>;
  acks: string[];
}

/**
 * The pack bytes for one exact object set, shared across identical fetches.
 * A pack holds only objects already in the store, and objects are never
 * mutated or deleted, so a cached pack stays valid for the trial's life; the
 * key is the repo plus the sorted object ids. Capped so a pathological
 * trial cannot grow it without bound (oldest entries go first).
 */
const PACK_CACHE_MAX = 128;
const packCache = new Map<string, Buffer>();

function cachedPack(repoId: number, packOids: readonly string[], packObjects: readonly GitObject[]): Buffer {
  const key = `${repoId}:${packOids.join(',')}`;
  const hit = packCache.get(key);
  if (hit !== undefined) return hit;
  const pack = writePack(packObjects);
  if (packCache.size >= PACK_CACHE_MAX) {
    const oldest = packCache.keys().next().value;
    if (oldest !== undefined) packCache.delete(oldest);
  }
  packCache.set(key, pack);
  return pack;
}

/**
 * Work out what a fetch sends. `depth` is the deepen value (1 = the tips only);
 * without it the whole history goes. Objects the client already holds are
 * computed from its haves, stopping at its shallow boundaries.
 */
function planFetch(repo: RepoRecord, args: FetchArgs): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // One tree's reachable objects, memoised per plan: a full fetch walks one
  // tree per commit, and the subtrees are shared between those trees.
  const treeCache = new Map<string, Map<string, GitObject>>();
  const treeObjects = (treeOid: string): Map<string, GitObject> => {
    const hit = treeCache.get(treeOid);
    if (hit !== undefined) return hit;
    const found = collectReachable([treeOid], lookup);
    treeCache.set(treeOid, found);
    return found;
  };
  // Commit distances from the wants (want = 1, its parent = 2, ...).
  const dist = new Map<string, number>();
  const queue: string[] = [];
  const includedCommits = new Set<string>();
  const includedObjects = new Map<string, GitObject>();
  const addCommitTree = (commitOid: string): void => {
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return;
    const treeOid = parseCommit(commit.data).tree;
    for (const [oid, object] of treeObjects(treeOid)) includedObjects.set(oid, object);
  };
  for (const want of args.wants) {
    const object = repo.objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') {
      includedObjects.set(want, object);
      const target = parseTagTarget(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject?.type === 'commit') {
        if (!dist.has(target)) {
          dist.set(target, 1);
          queue.push(target);
        }
      } else if (targetObject) {
        includedObjects.set(target, targetObject);
      }
      continue;
    }
    if (object.type === 'commit' && !dist.has(want)) {
      dist.set(want, 1);
      queue.push(want);
    } else if (object.type !== 'commit') {
      includedObjects.set(want, object);
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const oid = queue[head] as string;
    const d = dist.get(oid) as number;
    if (args.depth !== null && d > args.depth) continue;
    if (includedCommits.has(oid)) continue;
    includedCommits.add(oid);
    const object = repo.objects.get(oid);
    if (!object) continue;
    includedObjects.set(oid, object);
    addCommitTree(oid);
    if (args.depth !== null && d >= args.depth) continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!dist.has(parent)) {
        dist.set(parent, d + 1);
        queue.push(parent);
      }
    }
  }
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (args.depth !== null) {
    for (const oid of includedCommits) if (dist.get(oid) === args.depth) shallow.push(oid);
    for (const oid of args.shallow) {
      if (includedCommits.has(oid) && (dist.get(oid) ?? 0) < args.depth) unshallow.push(oid);
    }
  } else {
    for (const oid of args.shallow) if (includedCommits.has(oid)) unshallow.push(oid);
  }
  // What the client already holds: the haves' closure, not crossing its shallow boundaries.
  const held = new Set<string>();
  const heldQueue: string[] = [...args.haves];
  const heldSeen = new Set<string>();
  for (let head = 0; head < heldQueue.length; head += 1) {
    const oid = heldQueue[head] as string;
    if (heldSeen.has(oid)) continue;
    heldSeen.add(oid);
    const object = repo.objects.get(oid);
    if (!object) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const treeOid = parseCommit(object.data).tree;
      for (const [treeOid2] of treeObjects(treeOid)) held.add(treeOid2);
      if (!args.shallow.includes(oid)) {
        for (const parent of parseCommit(object.data).parents) heldQueue.push(parent);
      }
    } else if (object.type === 'tag') {
      held.add(parseTagTarget(object.data).object);
    }
  }
  // The pack's objects, sorted by their (already known) ids. Sorting by id
  // used to re-hash every object on every comparison — O(n log n) SHA-1s
  // per fetch — while the map keys already are the ids.
  const packEntries = [...includedObjects.entries()].filter(([oid]) => !held.has(oid));
  packEntries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const packOids = packEntries.map(([oid]) => oid);
  const packObjects = packEntries.map(([, object]) => object);
  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  const refs = sortedRefs(repo);
  for (const want of args.wants) {
    for (const ref of refs) if (ref.oid === want) wantedRefs.push({ oid: want, ref: ref.name });
  }
  const acks = args.haves.filter((have) => repo.objects.has(have));
  return { packObjects, packOids, shallow, unshallow, wantedRefs, acks };
}

/** Wrap bytes in sideband band-1 packets (each at most 65520 bytes of framing). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let offset = 0;
  // A packet carries the band byte plus pack data, and the pkt-line payload cap is 65516 bytes in total,
  // so a data chunk is at most 65515 bytes.
  const CHUNK = 65515;
  if (pack.length === 0) {
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
    return parts;
  }
  while (offset < pack.length) {
    const slice = pack.subarray(offset, offset + CHUNK);
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
    offset += slice.length;
  }
  return parts;
}

function handleFetchV2(repo: RepoRecord, packets: GitPacket[]): Buffer {
  const args = parseFetchArgs(packets, true);
  const plan = planFetch(repo, args);
  const pack = cachedPack(repo.id, plan.packOids, plan.packObjects);
  const parts: Buffer[] = [];
  // The response shape depends on whether the client will negotiate further.
  // A `done` request is stateless (every HTTP fetch): the server answers the
  // pack directly — no acknowledgments section and no wanted-refs, exactly as
  // a real git server does. Only a shallow fetch adds a shallow-info section
  // (present even when it holds no lines, per the real server).
  if (!args.done) {
    parts.push(encodePktLine('acknowledgments\n'));
    if (plan.acks.length === 0) parts.push(encodePktLine('NAK\n'));
    else for (const ack of plan.acks) parts.push(encodePktLine(`ACK ${ack}\n`));
    parts.push(PKT_DELIM);
  }
  if (args.shallowRequested) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  if (!args.done) {
    if (plan.wantedRefs.length > 0) {
      parts.push(encodePktLine('wanted-refs\n'));
      for (const ref of plan.wantedRefs) parts.push(encodePktLine(`${ref.oid} ${ref.ref}\n`));
      parts.push(PKT_DELIM);
    }
  }
  // packfile
  parts.push(encodePktLine('packfile\n'));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleFetchV0(repo: RepoRecord, packets: GitPacket[]): Buffer {
  const args = parseFetchArgs(packets, false);
  const plan = planFetch(repo, args);
  const pack = cachedPack(repo.id, plan.packOids, plan.packObjects);
  const parts: Buffer[] = [];
  if (plan.acks.length === 0) parts.push(encodePktLine('NAK\n'));
  else for (const ack of plan.acks) parts.push(encodePktLine(`ACK ${ack}\n`));
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  return Buffer.concat(parts);
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function handleUploadPack(store: Store, req: GitRequest): GitResponse {
  const repo = store.getRepo(req.owner, req.repo);
  if (!repo) return jsonResponse(404, { message: 'Not Found' });
  let packets: GitPacket[];
  try {
    packets = decodePktLines(req.body);
  } catch {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('malformed pkt-line stream', 'utf8') };
  }
  const first = packets.find((packet) => packet.kind === 'data');
  const firstLine = first && first.kind === 'data' ? first.payload.toString('utf8').replace(/\n$/, '') : '';
  try {
    if (firstLine === 'command=ls-refs') {
      return { status: 200, contentType: UPLOAD_RESULT, body: handleLsRefs(repo, packets) };
    }
    if (firstLine === 'command=fetch') {
      return { status: 200, contentType: UPLOAD_RESULT, body: handleFetchV2(repo, packets) };
    }
    // Anything else is a v0 fetch request (want/have/done lines).
    return { status: 200, contentType: UPLOAD_RESULT, body: handleFetchV0(repo, packets) };
  } catch (err) {
    return { status: 500, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: `fetch failed: ${err instanceof Error ? err.message : String(err)}` }), 'utf8') };
  }
}

// ---------------------------------------------------------------------------------------------
// receive-pack (v0)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function handleReceivePack(store: Store, req: GitRequest): GitResponse {
  const repo = store.getRepo(req.owner, req.repo);
  if (!repo) return jsonResponse(404, { message: 'Not Found' });
  // Walk the raw body pkt-line by pkt-line until the flush: everything before
  // it is the command list, everything after it is the pack (raw binary that
  // must never be fed to the pkt-line decoder).
  let commandEnd = -1;
  let packStart = req.body.length;
  {
    let offset = 0;
    let malformed = false;
    while (offset < req.body.length) {
      if (offset + 4 > req.body.length) {
        malformed = true;
        break;
      }
      const head = req.body.subarray(offset, offset + 4).toString('ascii');
      if (head === '0000') {
        commandEnd = offset + 4;
        packStart = offset + 4;
        break;
      }
      const length = parseInt(head, 16);
      if (!Number.isFinite(length) || length < 4 || offset + length > req.body.length) {
        malformed = true;
        break;
      }
      offset += length;
    }
    if (malformed || commandEnd === -1) {
      return { status: 400, contentType: 'text/plain', body: Buffer.from('malformed pkt-line stream', 'utf8') };
    }
  }
  let packets: GitPacket[];
  try {
    packets = decodePktLines(req.body.subarray(0, commandEnd));
  } catch {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('malformed pkt-line stream', 'utf8') };
  }
  const commands: PushCommand[] = [];
  let sideband = false;
  for (let i = 0; i < packets.length; i += 1) {
    const packet = packets[i] as GitPacket;
    if (packet.kind !== 'data') continue;
    const raw = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = raw.indexOf('\0');
    const line = nul === -1 ? raw : raw.slice(0, nul);
    const caps = nul === -1 ? '' : raw.slice(nul + 1);
    if (i === 0 && caps.includes('side-band-64k')) sideband = true;
    const parts = line.split(' ');
    if (parts.length !== 3) continue;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    commands.push({ oldOid, newOid, ref });
  }
  const packBytes = req.body.subarray(packStart);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const { objects } = readPack(packBytes, (oid) => repo.objects.get(oid));
      store.putObjects(repo, objects);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }
  const reportLines: string[] = [];
  if (unpackOk) {
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      const verdict = applyPush(store, repo, command);
      reportLines.push(verdict === null ? `ok ${command.ref}\n` : `ng ${command.ref} ${verdict}\n`);
    }
  } else {
    reportLines.push(`unpack ${unpackDetail}\n`);
  }
  // The report-status stream is itself pkt-lined inside band 1, INCLUDING its
  // terminating flush (a real git server sends `...ok <ref>\n0000` inside the
  // band-1 data, then a bare flush after the sideband packets).
  const report = Buffer.concat([encodePktLines(reportLines), PKT_FLUSH]);
  let body: Buffer;
  if (sideband) {
    const parts: Buffer[] = [];
    let offset = 0;
    const CHUNK = 65515;
    if (report.length === 0) {
      parts.push(encodePktLine(Buffer.from([1])));
    }
    while (offset < report.length) {
      const slice = report.subarray(offset, offset + CHUNK);
      parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
      offset += slice.length;
    }
    parts.push(PKT_FLUSH);
    body = Buffer.concat(parts);
  } else {
    // Without sideband the body is the report-status pkt-line stream itself,
    // which already ends with its terminating flush.
    body = report;
  }
  return { status: 200, contentType: RECEIVE_RESULT, body };
}

/** Apply one ref update; returns null on success or the refusal reason. */
function applyPush(store: Store, repo: RepoRecord, command: PushCommand): string | null {
  const current = repo.refs.get(command.ref);
  if (command.newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return 'remote ref does not exist';
    repo.refs.delete(command.ref);
    return null;
  }
  if (command.oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return 'already exists';
    if (!repo.objects.has(command.newOid)) return 'object not found';
    repo.refs.set(command.ref, command.newOid);
    return null;
  }
  if (current === undefined) return 'remote ref does not exist';
  if (current !== command.oldOid) return 'non-fast-forward';
  if (command.newOid === command.oldOid) return null;
  if (!repo.objects.has(command.newOid)) return 'object not found';
  if (!isAncestor(command.oldOid, command.newOid, (oid) => repo.objects.get(oid))) return 'non-fast-forward';
  repo.refs.set(command.ref, command.newOid);
  return null;
}
