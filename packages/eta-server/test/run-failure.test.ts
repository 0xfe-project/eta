/**
 * A failed run is visible after the fact (eta #60, AUDIT §3.3 rows 1 and 20).
 *
 * `turn:run-end { status: "failed" }` is an event, and an event reaches only the clients
 * watching when it fires. The record that outlives it is a `run_failed` journal entry: it
 * shows up as a system row in the session's state and in its history, so a client that was
 * not subscribed, a client that resyncs, and a server rebuilt on the same data directory all
 * see that the run failed and why — while the model is never sent any of it.
 *
 * Real sockets and a real data directory; the model layer is either absent (no provider at
 * all, the `model_unavailable` path) or scripted.
 */

import type {
  ServerFrame,
  SessionHistoryResult,
  SessionViewSections,
} from "@eta/client-contracts";
import type { ClientFrame } from "@eta/client-wire-proto";
import type { FakeModels } from "@eta/core/testing";
import type { AssembledServer } from "../src/server";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { JOURNAL_FILE } from "../src/file-store";
import { assembleServer } from "../src/server";

const roots: string[] = [];
const servers: AssembledServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function until(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Client {
  frames: ServerFrame[];
  call: (target: string, action: string, args?: unknown) => Promise<unknown>;
  subscribe: (target: string) => void;
  close: () => void;
}

function connect(port: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const frames: ServerFrame[] = [];
    const pending = new Map<
      string,
      { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >();
    let nextId = 1;
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(
        String((event as MessageEvent).data),
      ) as ServerFrame;
      frames.push(frame);
      if (frame.type !== "reply") return;
      const waiter = pending.get(frame.requestId);
      if (waiter === undefined) return;
      pending.delete(frame.requestId);
      if (frame.ok) waiter.resolve(frame.result);
      else waiter.reject(new Error(frame.error));
    });
    socket.addEventListener("error", () =>
      reject(new Error("the socket could not connect")),
    );
    socket.addEventListener("open", () => {
      resolve({
        frames,
        call(target, action, args) {
          const requestId = `r${nextId++}`;
          const payload: ClientFrame = {
            op: "call",
            target,
            action,
            ...(args === undefined ? {} : { args }),
            requestId,
          };
          socket.send(JSON.stringify(payload));
          return new Promise((res, rej) =>
            pending.set(requestId, { resolve: res, reject: rej }),
          );
        },
        subscribe(target) {
          socket.send(JSON.stringify({ op: "subscribe", target }));
        },
        close() {
          socket.close();
        },
      });
    });
  });
}

async function start(
  root: string,
  models?: FakeModels,
): Promise<{ server: AssembledServer; client: Client }> {
  const server = await assembleServer({
    dataDir: root,
    configPath: join(root, "no-such-config.json"),
    ...(models === undefined ? {} : { models: models as never }),
  });
  servers.push(server);
  const client = await connect(server.server.port);
  await until(() => client.frames.some((frame) => frame.type === "hello"));
  return { server, client };
}

async function stop(server: AssembledServer, client: Client): Promise<void> {
  client.close();
  servers.splice(servers.indexOf(server), 1);
  await server.close();
}

/** The `turn:run-end` events a subscribed client got for one session. */
function runEnds(
  client: Client,
  session: string,
): { runId: string; status: string; error?: string }[] {
  return client.frames
    .filter(
      (frame): frame is Extract<ServerFrame, { type: "event" }> =>
        frame.type === "event" &&
        frame.target === `sessions.${session}` &&
        frame.name === "turn:run-end",
    )
    .map(
      (frame) =>
        frame.data as { runId: string; status: string; error?: string },
    );
}

async function failureRows(client: Client, session: string) {
  const resync = (await client.call("sessions", "resync", { session })) as {
    state: { sections: Pick<SessionViewSections, "systems" | "transcript"> };
  };
  const history = (await client.call("sessions", "history", {
    session,
  })) as SessionHistoryResult;
  return {
    view: resync.state.sections.systems.rows.filter(
      (row) => row.kind === "run_failed",
    ),
    transcript: resync.state.sections.transcript,
    history: (history.systems ?? []).filter((row) => row.kind === "run_failed"),
  };
}

/** Prompt over a watching client and wait for that run's end event. */
async function promptAndWait(
  watcher: Client,
  session: string,
  text: string,
): Promise<void> {
  const before = runEnds(watcher, session).length;
  await watcher.call("sessions", "prompt", { session, text });
  await until(() => runEnds(watcher, session).length > before);
}

describe("a failed run, after the fact", () => {
  it("model_unavailable is in resync and history — for a client that never watched, and after a restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "eta-run-failed-"));
    roots.push(root);
    // No `models` and no config: there is no provider at all.
    let { server, client: watcher } = await start(root);
    const { session } = (await watcher.call("sessions", "create", {
      cwd: "/work/eta",
    })) as { session: string };
    watcher.subscribe(`sessions.${session}`);
    await until(() =>
      watcher.frames.some(
        (frame) =>
          frame.type === "state" && frame.target === `sessions.${session}`,
      ),
    );
    await promptAndWait(watcher, session, "hello?");
    const [end] = runEnds(watcher, session);
    expect(end).toMatchObject({ status: "failed" });
    expect(end?.error).toMatch(/^model_unavailable/);

    // A second client that subscribed to nothing.
    const late = await connect(server.server.port);
    const seen = await failureRows(late, session);
    expect(seen.view).toEqual([
      {
        entryId: expect.any(String),
        seq: expect.any(Number),
        at: expect.any(Number),
        kind: "run_failed",
        args: { runId: end!.runId, error: end!.error },
      },
    ]);
    expect(seen.history).toEqual(seen.view);
    // The transcript is the conversation: the user's turn, and no fabricated answer.
    expect(seen.transcript.messages.map((row) => row.message.role)).toEqual([
      "user",
    ]);
    late.close();

    // On disk, in the journal file.
    const journal = await readFile(
      join(root, "sessions", session, JOURNAL_FILE),
      "utf8",
    );
    expect(journal.match(/"run_failed"/g)).toHaveLength(1);

    // A server rebuilt on the same data directory still says so.
    await stop(server, watcher);
    ({ server, client: watcher } = await start(root));
    const after = await failureRows(watcher, session);
    expect(after.view.map((row) => row.args)).toEqual([
      { runId: end!.runId, error: end!.error },
    ]);
    expect(after.history).toEqual(after.view);
    watcher.close();
  });

  it("a provider failure is recorded once, never sent back, and a completed retry adds nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "eta-run-failed-"));
    roots.push(root);
    const models = fakeModels([
      assistantMessage({
        content: [{ type: "text", text: "half an answer" }],
        stopReason: "error",
        errorMessage: "401 Unauthorized: invalid api key",
      }),
      assistantMessage({ content: [{ type: "text", text: "a real answer" }] }),
    ]);
    const { client } = await start(root, models);
    const { session } = (await client.call("sessions", "create", {
      cwd: "/work/eta",
    })) as { session: string };
    client.subscribe(`sessions.${session}`);
    await until(() =>
      client.frames.some(
        (frame) =>
          frame.type === "state" && frame.target === `sessions.${session}`,
      ),
    );

    await promptAndWait(client, session, "first try");
    const [failed] = runEnds(client, session);
    expect(failed).toMatchObject({
      status: "failed",
      error: "401 Unauthorized: invalid api key",
    });
    let seen = await failureRows(client, session);
    expect(seen.view.map((row) => row.args)).toEqual([
      { runId: failed!.runId, error: failed!.error },
    ]);
    expect(JSON.stringify(seen.transcript)).not.toContain("half an answer");

    await promptAndWait(client, session, "second try");
    expect(runEnds(client, session).map((end) => end.status)).toEqual([
      "failed",
      "completed",
    ]);
    // What the retry sent: the user's turns, nothing of the failure.
    const sent = JSON.stringify(models.calls.at(-1)?.context.messages);
    expect(sent).toContain("second try");
    expect(sent).not.toContain("half an answer");
    expect(sent).not.toContain("401 Unauthorized");
    // Still the one record: resyncing and reading history do not write.
    seen = await failureRows(client, session);
    seen = await failureRows(client, session);
    expect(seen.view).toHaveLength(1);
    expect(seen.history).toHaveLength(1);
    const journal = await readFile(
      join(root, "sessions", session, JOURNAL_FILE),
      "utf8",
    );
    expect(journal.match(/"run_failed"/g)).toHaveLength(1);
    client.close();
  });
});
