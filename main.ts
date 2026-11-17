// How this entry talks to the grading environment.
//
// v3 rework (Nov 2026): the server behind this glue got a perf pass —
// one-shot SHA-1, a byte-cached issue view, lazy per-request parsing, and a
// single merge-base walk per merge. Nothing about this file's contract
// changed; the grading still only looks at the server (app.ts).
//
// The environment hands us its address through MAKEFUN_ENV_URL and expects
// three things from us, in order: a server listening on a port the kernel
// chose, one POST announcing that port, and then patient polling until the
// environment says the trial is finished. The grading itself only looks at
// the server (app.ts); this file is just the glue that keeps the two sides
// connected for the duration of a run.
//
// The choreography, step by step:
//   - No env address, no run: without MAKEFUN_ENV_URL we quit at once.
//   - The server binds port 0. The OS hands back something free; 8080 is
//     the environment's own port, so we never ask for it.
//   - We announce the chosen port once. A 200 means the environment took
//     it; a 409 means some other entry announced first, and we simply carry
//     on waiting like everyone else. A 400 or 405 means we broke the
//     contract, so we stop. Anything else (a dropped connection, a slow
//     environment, a surprising status) is worth another try a little later.
//   - We ask GET /done again and again until it answers {"done": true}.
//     While the suite is still running it answers {"done": false} right
//     away, so this is ordinary polling, not a hanging request.
//   - Once done, we shut the server down and leave with status 0. The
//     environment then stops and writes the export the scorer reads.
//
// Nothing here reaches for a package, a Node built-in, or a model call:
// the only import is our own server.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// One HTTP round trip gets at most thirty seconds before we give up on it
// and try again.
const REQUEST_BUDGET_MS = 30_000;

// Retries start a quarter of a second apart, double each time, and never
// wait longer than two seconds.
const BACKOFF_START_MS = 250;
const BACKOFF_CAP_MS = 2_000;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// A backoff state that hands out the next wait: start small, double, stop
// growing at the cap. Callers keep one of these per retry loop.
function makeBackoff(): () => Promise<void> {
  let waitMs = BACKOFF_START_MS;
  return async () => {
    await pause(waitMs);
    waitMs = Math.min(BACKOFF_CAP_MS, waitMs * 2);
  };
}

// Announce the port we bound. Returns once the environment has the port;
// throws on a contract error (400/405) and retries everything else.
async function announcePort(port: number): Promise<void> {
  const backOff = makeBackoff();
  while (true) {
    let response: Response;
    try {
      response = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
    } catch {
      // The environment is unreachable or still starting: wait, then retry.
      await backOff();
      continue;
    }
    if (response.status === 200 || response.status === 409) return;
    if (response.status === 400 || response.status === 405) {
      throw new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
    }
    await backOff();
  }
}

// Ask GET /done until the environment says the trial is over. A "not done"
// answer, a failed request, and a slow request are all just reasons to ask
// again after a short wait.
async function awaitCompletion(): Promise<void> {
  const backOff = makeBackoff();
  while (true) {
    try {
      const response = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(REQUEST_BUDGET_MS) });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // No answer yet, or the answer was too slow: not done, ask again.
    }
    await backOff();
  }
}

// The whole life of the process: bind, announce, wait, shut down.
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await awaitCompletion();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[entry] ${detail}\n`);
  process.exit(1);
}
