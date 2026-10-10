import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  rstest,
} from "@rstest/core";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { chatQueryOptions } from "@/queries/chat";
import { LiveChat } from "./live-chat";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** A stand-in EventSource the test opens, fails and closes. */
class FakeEventSource {
  static CLOSED = 2;
  static all: FakeEventSource[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.all.push(this);
  }
  listeners = new Map<string, (event: MessageEvent) => void>();
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, listener);
  }
  removeEventListener(type: string) {
    this.listeners.delete(type);
  }
  emit(type: string, data: unknown) {
    this.listeners.get(type)?.({
      type,
      data: JSON.stringify(data),
    } as MessageEvent);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  /** The server answered with something other than a stream (e.g. 503). */
  giveUp() {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }
  static open() {
    return FakeEventSource.all.filter((s) => s.readyState !== 2);
  }
}

const snapshot = {
  agents: [],
  active_replies: [],
  event_cursor: "c1",
};
let answers: (() => Response)[];
let snapshotRequests = 0;

function Page() {
  // Pages read the snapshot without subscribing themselves.
  const { data } = useQuery(chatQueryOptions());
  return <output>{data?.agents.length ?? 0}</output>;
}

async function render() {
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(
      <QueryClientProvider client={new QueryClient()}>
        <LiveChat />
        <Page />
        <Page />
      </QueryClientProvider>,
    );
  });
}

async function wait(ms: number) {
  await act(async () => {
    await rstest.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  rstest.useFakeTimers();
  FakeEventSource.all = [];
  (globalThis as Record<string, unknown>).EventSource = FakeEventSource;
  answers = [];
  snapshotRequests = 0;
  rstest.spyOn(globalThis, "fetch").mockImplementation(async () => {
    snapshotRequests++;
    return (answers.shift() ?? (() => Response.json(snapshot)))();
  });
});

afterEach(() => {
  rstest.useRealTimers();
  rstest.restoreAllMocks();
  document.body.innerHTML = "";
});

const unavailable = () =>
  Response.json(
    { error: { code: "UPSTREAM_UNAVAILABLE", message: "x" } },
    { status: 503 },
  );

describe("the chat stream", () => {
  it("brings a new agent to whatever page is open", async () => {
    await render();
    await wait(0);
    const badge = () => document.querySelector("output")?.textContent;
    expect(badge()).toBe("0");
    await act(async () =>
      FakeEventSource.all[0].emit("agent.updated", {
        agent: {
          id: "a1",
          name: "研究员",
          description: "",
          model: null,
          bundles: [],
          status: "idle",
          build_error: null,
          revision: 1,
        },
      }),
    );
    await wait(0); // react-query notifies on the next tick
    expect(badge()).toBe("1");
  });

  it("is opened once for the whole app", async () => {
    await render();
    await wait(0);
    expect(FakeEventSource.all.map((s) => s.url)).toEqual([
      "/api/v1/chat/stream?cursor=c1",
    ]);
  });

  it("reconnects after closing, even when the cursor stays the same", async () => {
    await render();
    await wait(0);
    FakeEventSource.all[0].giveUp();
    expect(FakeEventSource.open()).toEqual([]);
    await wait(1000);
    // The snapshot was reloaded, kept its cursor, and the stream reopened.
    expect(snapshotRequests).toBe(2);
    expect(FakeEventSource.all).toHaveLength(2);
    expect(FakeEventSource.open()).toHaveLength(1);
    expect(FakeEventSource.all[1].url).toBe("/api/v1/chat/stream?cursor=c1");
  });

  it("keeps trying, more slowly, while the server is away", async () => {
    await render();
    await wait(0);
    answers = Array.from<() => Response>({ length: 2 }).fill(unavailable);
    FakeEventSource.all[0].giveUp();
    await wait(1000);
    // The reload failed: the stream reopens from the old cursor.
    expect(snapshotRequests).toBe(2);
    expect(FakeEventSource.all[1].url).toBe("/api/v1/chat/stream?cursor=c1");
    FakeEventSource.all[1].giveUp();
    await wait(1000);
    expect(snapshotRequests).toBe(2); // backing off: 2 s now
    await wait(1000);
    expect(snapshotRequests).toBe(3);
    expect(FakeEventSource.all).toHaveLength(3);
    FakeEventSource.all[2].onopen?.();
    expect(FakeEventSource.open()).toHaveLength(1);
  });

  it("retries a snapshot that failed, with a backoff", async () => {
    answers = Array.from<() => Response>({ length: 2 }).fill(unavailable);
    await render();
    await wait(1000);
    expect(snapshotRequests).toBe(2);
    expect(FakeEventSource.all).toEqual([]);
    await wait(1000);
    expect(snapshotRequests).toBe(2); // backing off: 2 s now
    await wait(1000);
    expect(snapshotRequests).toBe(3);
    expect(FakeEventSource.open()).toHaveLength(1);
  });
});
