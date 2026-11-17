/**
 * One version's client, run against another version's host: the "old client, new host" half of a
 * release check, which no unit test can make believe because both sides have to be real processes.
 *
 *   bun scripts/upgrade-e2e/wire-client.ts <wire.ts> <port> hello
 *   bun scripts/upgrade-e2e/wire-client.ts <wire.ts> <port> talk <conversationId> <agentId>
 *   bun scripts/upgrade-e2e/wire-client.ts <wire.ts> <port> degrade <conversationId>
 *
 * `<wire.ts>` is a tree's `apps/tui/src/connection/wire.ts` — the client that tree ships — and the
 * host is one started on that port with `--allow-origin http://127.0.0.1:<port>` (which is why the
 * socket below sets the origin and sends no token). Run it from the tree whose wire it is, so its
 * own `node_modules` resolve; the host may be that same tree or another one:
 *
 *   # what a 0.4.0-rc.3 client finds on this build's host, and whether it can still talk
 *   cd ../rc3 && bun <this>/wire-client.ts apps/tui/src/connection/wire.ts 18921 talk <c> <a>
 *
 * The three modes answer the three questions of a protocol upgrade: does `hello` arrive and what
 * does it carry (`hello`); can a message go out and its reply come back (`talk`); and does a call
 * to something the other side lacks fail as an error while the connection stays usable
 * (`degrade`).
 */
import { resolve } from "node:path";
import process from "node:process";

/** The slice of a tree's `WireClient` this uses (`apps/tui/src/connection/types.ts`). */
interface WireClient {
  readonly store: { getState: () => WireState };
  can: (op: string) => boolean;
  call: <T = unknown>(
    target: string,
    action: string,
    args?: unknown,
    options?: { timeoutMs?: number },
  ) => Promise<T>;
  subscribe: (target: string) => () => void;
  onEvent: (
    target: string,
    listener: (event: { name: string }) => void,
  ) => () => void;
  connect: () => void;
  close: () => void;
}

interface WireState {
  status: string;
  ops: string[];
  mounted: { name: string }[];
  targets: Record<string, { sections: Record<string, unknown> }>;
}

interface WireModule {
  Wire: new (options: {
    url: string;
    createSocket: (url: string, token: string | undefined) => unknown;
    callTimeoutMs?: number;
    initialRetryMs?: number;
    maxRetryMs?: number;
  }) => WireClient;
}

const [wirePath, portText, mode, conversationArg, agentArg] =
  process.argv.slice(2);
if (wirePath === undefined || portText === undefined || mode === undefined)
  throw new Error(
    "usage: wire-client.ts <wire.ts> <port> <hello|talk|degrade> [...]",
  );
const port = Number(portText);
const origin = `http://127.0.0.1:${port}`;

// Relative to where this is run, which is the tree whose wire it is (`cd ../rc3 && bun ...`).
const { Wire } = (await import(resolve(process.cwd(), wirePath))) as WireModule;
const wire = new Wire({
  url: `ws://127.0.0.1:${port}/ws`,
  createSocket: (url: string) => new WebSocket(url, { headers: { origin } }),
  callTimeoutMs: 60_000,
  initialRetryMs: 200,
  maxRetryMs: 1_000,
});

const state = (): WireState => wire.store.getState();

/** Polls until `read` answers, which is how a client waits for a frame that has not come yet. */
async function until<T>(
  what: string,
  read: () => T | undefined,
  ms = 60_000,
): Promise<T> {
  for (const end = Date.now() + ms; ; ) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > end)
      throw new Error(
        `timed out waiting for ${what} (status ${state().status})`,
      );
    await Bun.sleep(50);
  }
}

const out: Record<string, unknown> = {};
wire.connect();
await until(
  "hello",
  () => (state().status === "open" ? true : undefined),
  90_000,
);
out.hello = {
  status: state().status,
  ops: [...state().ops].sort(),
  mounted: state()
    .mounted.map((mount) => mount.name)
    .sort(),
};

if (mode === "talk") {
  const conversationId = conversationArg!;
  const agentId = agentArg!;
  const events: string[] = [];
  const releaseEvents = wire.onEvent("conversations", (event) =>
    events.push(event.name),
  );
  const releaseState = wire.subscribe("conversations");
  const pushed = await until(
    "the conversations state",
    () => state().targets.conversations?.sections,
    30_000,
  );
  const history = () =>
    wire.call<{ messages: { text?: string; agentId?: string | null }[] }>(
      "conversations",
      "history",
      { conversationId, limit: 10 },
    );
  const before = await history();
  await wire.call("conversations", "send", {
    conversationId,
    text: "@Ada Is this thing on? (asked over the wire)",
    mentions: [agentId],
  });
  // The reply is the one this send caused, and it is the newest thing in the conversation: the
  // question came from the user, and Ada answers it. (The page holds the last ten, so counting
  // from the front would compare against a moving window.)
  let after = before;
  const answered = () => {
    const newest = after.messages.at(-1);
    return newest?.agentId === agentId && (newest.text ?? "") !== "";
  };
  for (const end = Date.now() + 150_000; Date.now() < end; ) {
    after = await history();
    if (answered()) break;
    await Bun.sleep(500);
  }
  const newest = after.messages.at(-1);
  out.talk = {
    stateSections: Object.keys(pushed),
    events: [...new Set(events)],
    before: before.messages.map((m) => (m.text ?? "").slice(0, 40)),
    after: after.messages.map((m) => (m.text ?? "").slice(0, 40)),
    reply:
      newest === undefined
        ? null
        : { agentId: newest.agentId, text: (newest.text ?? "").slice(0, 60) },
    replied: answered(),
  };
  releaseEvents();
  releaseState();
}

if (mode === "degrade") {
  // An op this build has and a host from before it does not: `hello` is what a client has to
  // find out from, and a call made anyway must come back as an error, not as a dead connection.
  const added = "tasks.workspaceFor";
  const attempt: Record<string, unknown> = { can: wire.can(added) };
  try {
    await wire.call("tasks", "workspaceFor", {});
    attempt.call = "accepted";
  } catch (error) {
    attempt.call = {
      code: (error as { code?: string }).code,
      message: (error as Error).message,
    };
  }
  const stillThere = await wire.call<{ messages: unknown[] }>(
    "conversations",
    "history",
    { conversationId: conversationArg!, limit: 3 },
  );
  attempt.afterwards = {
    status: state().status,
    messages: stillThere.messages.length,
  };
  out.degrade = attempt;
}

wire.close();
process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
// A file that is not a terminal takes the write asynchronously; exiting at once lands half of it.
await Bun.sleep(100);
process.exit(0);
