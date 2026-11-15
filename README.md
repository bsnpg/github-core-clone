# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/bsnpg/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/bsnpg/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Referral code: `26zqsqqz`

A standalone GitHub-compatible git forge in one process, built for [make.fun's github-core-clone-01](https://make.fun/bounty/github-core-clone-01): a git smart-HTTP server, the REST v3 API, GraphQL v4, and an MCP endpoint, all over one in-memory store. No dependencies, no git binary, no outside service, no proxy — Node's standard library only.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its own. There is nothing to install: the program imports `node:http`, `node:crypto`, `node:zlib` and its own modules only, and the trial has no package manager and no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL` (`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one. Never bind 8080: that is the env's port.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON. The first register wins.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers `{"done":false}` while the suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never exit before it says `true`.
4. **Exit 0** when it does.

## The surface

- **Git smart HTTP** at `/{owner}/{repo}.git`: upload-pack protocol v2 (`ls-refs`, `fetch`, including shallow/deepen and thin packs) and receive-pack v0 (`report-status`, `side-band-64k`, `delete-refs`), with fast-forward enforcement — a non-fast-forward push is refused per ref with `ng <ref> non-fast-forward` and the ref does not move. Packs are written and read by hand (`gitproto.ts`): SHA-1 object ids, zlib objects, plain pack v2, no deltas. Verified against real git (clone, fetch, push, shallow clone, branch delete) as well as the suite's client.
- **REST v3** under `/api/v3`: repositories, branches, commits, git refs, contents (create/update/delete with stale-sha `409`), labels, issues, comments, pull requests (including squash merge with a real merge commit on the default branch), `Link` pagination, `X-GitHub-Request-Id` on every reply, JSON errors with a string `message`, `404` JSON for unknown routes, `400` for malformed JSON, `401` for a missing bearer token, and `404` (never `403`) for a repository under another owner.
- **GraphQL v4** at `/api/graphql`: `viewer`, `repository`, `node(id:)` with inline fragments, `search`, `__type`/`__schema` introspection, cursor pagination on `issues`, and the `createIssue` / `closeIssue` / `createPullRequest` / `mergePullRequest` / `addComment` mutations. Global ids are opaque (`R<id>`, `I<id>-<n>`, `P<id>-<n>`) and stable across reads. A GraphQL-level failure is an HTTP 200 carrying `errors`; two operation documents in one body answer two bodies in order.
- **MCP** at `/mcp`: JSON-RPC 2.0 Streamable HTTP, modern revision `2026-07-28` (`server/discover` answers identity, capabilities and `supportedVersions`) with the legacy `initialize` handshake also answered. Six tools — `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request` — acting on the same store as REST. An unknown tool is JSON-RPC `-32602`, a call without its required arguments answers `isError: true`, and a body that is not JSON is HTTP 400 with JSON-RPC `-32700`.

## Determinism

A trial is replayed and its state export must come out byte for byte. So the forge never reads a wall clock and never draws unseeded randomness: every timestamp comes from `MAKEFUN_TRIAL_NOW`, every id is a counter, every request id is a counter, and the one request at a time is answered in the order it arrived. The store is in-memory and fresh per trial.

## Layout

| File | What it holds |
| --- | --- |
| `main.ts` | The entry ↔ env lifecycle (kept as the starter ships it). |
| `app.ts` | The HTTP dispatcher: routing, body reading, auth, request ids. |
| `git.ts` | The smart-HTTP handlers (upload-pack v2, receive-pack v0). |
| `gitproto.ts` | Pkt-lines, SHA-1 objects, pack read/write, tree/commit parsing. |
| `store.ts` | The in-memory store: repos, objects, refs, issues, pulls, merges. |
| `rest.ts` | The REST v3 router and views. |
| `graphql.ts` | A small GraphQL document parser and executor. |
| `mcp.ts` | The MCP endpoint and its six tools. |
| `util.ts` | Trial time, base64, and the deterministic id helpers. |

## Verification

The kit's own sealed conformance runner (`sdk/run.ts`) against a local boot of this forge: **120/120 checks** (git 30/30, repos 15/15, issues 15/15, pulls 20/20, protocol 5/5, graphql 20/20, mcp 15/15), with perf points 150–165/200 across runs (push ~45–50, clone ~28–41, read ~40–42, write ~34–42). Real `git` (2.43) clone/fetch/push/shallow-clone/branch-delete were also verified by hand against the forge.
