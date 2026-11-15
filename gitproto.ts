// gitproto.ts — git's wire formats, implemented from the protocol itself:
// pkt-lines, the object model (commit/tree/blob/tag), packfiles (read + write,
// including OFS_DELTA and REF_DELTA resolution), and reachability walks.
//
// No git binary is involved anywhere: the forge stores objects as bytes and
// re-emits them byte-for-byte.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { sha1Hex, ZERO_OID } from './util.ts';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

/** git's LARGE_PACKET_MAX: the largest pkt-line including its 4-byte length. */
export const PKT_LINE_MAX = 65520;

const TYPE_CODES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const CODE_TYPES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** The SHA-1 of an object, exactly as git computes it: `sha1("<type> <size>\0" + bytes)`. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

export type GitPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Encode one data packet: 4 hex length bytes (payload + 4) then the payload. */
export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  if (data.length > PKT_LINE_MAX - 4) throw new Error(`pkt-line payload is ${data.length} bytes, over the limit`);
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Encode a mixed sequence; 'flush' / 'delim' / 'response-end' are control packets. */
export function encodePktLines(items: readonly (string | Uint8Array | 'flush' | 'delim' | 'response-end')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else if (item === 'response-end') parts.push(Buffer.from('0002', 'ascii'));
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

/** Decode a whole buffer of pkt-lines into packets. Throws on a malformed frame. */
export function decodePktLines(buf: Buffer): GitPacket[] {
  const packets: GitPacket[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (head === '0001') {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (head === '0002') {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    const length = parseInt(head, 16);
    if (!Number.isFinite(length) || length < 4 || offset + length > buf.length) {
      throw new Error(`bad pkt-line length ${JSON.stringify(head)} at offset ${offset}`);
    }
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

// ---------------------------------------------------------------------------------------------
// object parsing and building
// ---------------------------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's bytes. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface CommitBuild {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
}

/** Build a commit object's bytes. `author`/`committer` are full ident lines. */
export function buildCommit(build: CommitBuild): Buffer {
  let out = `tree ${build.tree}\n`;
  for (const parent of build.parents) out += `parent ${parent}\n`;
  out += `author ${build.author}\n`;
  out += `committer ${build.committer}\n`;
  out += `\n${build.message}`;
  return Buffer.from(out, 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's bytes into entries (in stored order). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw new Error('malformed tree: no space after mode');
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1) throw new Error('malformed tree: no NUL after name');
    const name = data.subarray(space + 1, nul).toString('utf8');
    if (nul + 21 > data.length) throw new Error('malformed tree: truncated oid');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Build a tree object's bytes from entries (sorted git-style: directories compare as if ending in '/'). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const aKey = a.mode === '40000' ? `${a.name}/` : a.name;
    const bKey = b.mode === '40000' ? `${b.name}/` : b.name;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tag object: the object it points at. */
export function parseTagTarget(data: Buffer): { object: string; type: string } {
  const text = data.toString('utf8');
  let object = '';
  let type = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line === '') break;
  }
  return { object, type };
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

/** Read one pack entry's varint size header: returns the type code, size and next offset. */
function readPackEntryHeader(buf: Buffer, offset: number): { typeCode: number; size: number; next: number } {
  const first = buf[offset] ?? 0;
  const typeCode = (first >> 4) & 0x07;
  let size = first & 0x0f;
  let shift = 4;
  let at = offset + 1;
  while ((buf[at - 1] ?? 0) & 0x80) {
    const byte = buf[at] ?? 0;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    at += 1;
  }
  return { typeCode, size, next: at };
}

/** Read an OFS_DELTA base offset encoding. */
function readOfsDeltaBase(buf: Buffer, offset: number): { baseOffset: number; next: number } {
  let byte = buf[offset] ?? 0;
  let baseOffset = byte & 0x7f;
  let at = offset + 1;
  while (byte & 0x80) {
    byte = buf[at] ?? 0;
    baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
    at += 1;
  }
  return { baseOffset, next: at };
}

/**
 * Inflate one zlib stream starting at `offset` in `buf` (bounded by `end`).
 * Returns the inflated bytes and the offset just past the stream, using the
 * engine's consumed-byte count so the next entry starts at exactly the right place.
 */
function inflateAt(buf: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset, end);
  const result = inflateSync(view, { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine?.bytesWritten ?? 0;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: Buffer.from(result.buffer), next: offset + written };
}

/** Apply a git delta (copy/insert instructions) to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at++] ?? 0;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error(`delta base size ${baseSize} does not match ${base.length}`);
  const parts: Buffer[] = [];
  let total = 0;
  while (at < delta.length) {
    const op = delta[at++] ?? 0;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) offset |= (delta[at++] ?? 0) << (8 * i);
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) size |= (delta[at++] ?? 0) << (8 * i);
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy runs past the base');
      parts.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op !== 0) {
      if (at + op > delta.length) throw new Error('delta insert runs past the delta');
      parts.push(delta.subarray(at, at + op));
      at += op;
      total += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  if (total !== resultSize) throw new Error(`delta produced ${total} bytes, expected ${resultSize}`);
  return Buffer.concat(parts);
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Parse a whole packfile. `resolveBase` supplies objects the pack's thin
 * REF_DELTA entries name but the pack does not carry (the client's haves).
 */
export function readPack(pack: Uint8Array, resolveBase?: (oid: string) => GitObject | undefined): PackReadResult {
  const buf = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buf.length < 32) throw new Error(`pack is ${buf.length} bytes, too short`);
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const trailer = buf.subarray(trailerStart).toString('hex');
  const computed = sha1Hex(buf.subarray(0, trailerStart));
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackEntryHeader(buf, offset);
    offset = header.next;
    const entry: RawEntry = { offset: entryOffset, typeCode: header.typeCode, size: header.size, data: Buffer.alloc(0) };
    if (header.typeCode === 6) {
      const base = readOfsDeltaBase(buf, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset`);
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (header.typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!TYPE_CODES[header.typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${header.typeCode}`);
    }
    const inflated = inflateAt(buf, offset, trailerStart);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  let deltaCount = 0;
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved !== undefined && entry.resolvedType !== undefined && entry.oid !== undefined) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset ?? -1);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid ?? '';
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = TYPE_CODES[entry.typeCode] as GitObjectType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { objects, deltaCount };
}

/** Write one pack entry header (type + size varint). */
function writePackEntryHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size >>= 4;
  if (size !== 0) first |= 0x80;
  bytes.push(first);
  while (size !== 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size !== 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Write a packfile (version 2, plain objects only, no deltas) with its trailer checksum. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackEntryHeader(CODE_TYPES[object.type], object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

/** A lookup for objects by id (the store's view). */
export type ObjectLookup = (oid: string) => GitObject | undefined;

/**
 * All objects reachable from `roots` (commits and their trees/blobs, tags and
 * their targets), in BFS order. Throws when a needed object is missing.
 */
export function collectReachable(roots: readonly string[], lookup: ObjectLookup): Map<string, GitObject> {
  const found = new Map<string, GitObject>();
  const queue: string[] = [...roots];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object) throw new Error(`missing object ${oid}`);
    found.set(oid, object);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    } else if (object.type === 'tag') {
      queue.push(parseTagTarget(object.data).object);
    }
  }
  return found;
}

/** The commit ids reachable from `roots` (parents only, newest-first by discovery). */
export function collectCommits(roots: readonly string[], lookup: ObjectLookup): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    order.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return order;
}

/** True when `ancestor` is reachable from `tip` (or equal to it). */
export function isAncestor(ancestor: string, tip: string, lookup: ObjectLookup): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** The merge-base of two commits: the first common ancestor found by a joint BFS. */
export function mergeBase(a: string, b: string, lookup: ObjectLookup): string | null {
  if (a === b) return a;
  const ancestorsA = new Set<string>(collectCommits([a], lookup));
  const queue: string[] = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}

/** A flat map of path -> blob oid for the tree at `treeOid` (recursive). */
export function flattenTree(treeOid: string, lookup: ObjectLookup): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (oid: string, prefix: string): void => {
    const object = lookup(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, entry.oid);
    }
  };
  walk(treeOid, '');
  return out;
}

/** The empty tree's id (a tree object with no entries). */
export const EMPTY_TREE_OID = hashObject('tree', Buffer.alloc(0));
export { ZERO_OID };
