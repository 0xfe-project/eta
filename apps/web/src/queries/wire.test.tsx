import { afterEach, describe, expect, it } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { setWire, WireError } from "@/lib/wire";
import { FakeHost } from "@/test-wire";
import {
  useConnectionLost,
  useTarget,
  useWireMutation,
  wireErrorMessage,
} from "./wire";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function Reader({ target }: { target: string }) {
  const state = useTarget(target);
  return (
    <output data-target={target}>
      {state === undefined ? "loading" : JSON.stringify(state.sections)}
    </output>
  );
}

function Readers({ count }: { count: number }) {
  return Array.from({ length: count }, (_, index) => (
    <Reader key={index} target="agents" />
  ));
}

function Lost() {
  return <i>{useConnectionLost() ? "lost" : "ok"}</i>;
}

function Save({ onDone }: { onDone: (outcome: string) => void }) {
  const save = useWireMutation<{ id: string }, { revision: string }>(
    "providers",
    "save",
  );
  return (
    <button
      type="button"
      onClick={() =>
        save.mutate(
          { id: "a" },
          {
            onSuccess: (result) => onDone(result.revision),
            onError: (error) => onDone(wireErrorMessage(error)),
          },
        )
      }
    />
  );
}

const cleanup: (() => void)[] = [];

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient();
  const show = (next: React.ReactNode) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>{next}</QueryClientProvider>,
      ),
    );
  await show(node);
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  return show;
}

afterEach(async () => {
  await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
  setWire(undefined);
});

const subscribes = (host: FakeHost, op: "subscribe" | "unsubscribe") =>
  host.socket.framesOf(op).map((frame) => frame.target);

describe("reading a target", () => {
  it("subscribes for the first reader and lets go with the last", async () => {
    const host = new FakeHost().target("agents", { list: [1] }).install();
    host.hello();
    const show = await render(<Readers count={2} />);
    expect(subscribes(host, "subscribe")).toEqual(["agents"]);
    expect(document.body.textContent).toBe('{"list":[1]}{"list":[1]}');

    // One reader leaves; the other still wants it.
    await show(<Readers count={1} />);
    expect(subscribes(host, "unsubscribe")).toEqual([]);

    await show(<Readers count={0} />);
    expect(subscribes(host, "unsubscribe")).toEqual(["agents"]);
  });

  it("shows the state hello carried at once, then follows patches", async () => {
    const host = new FakeHost()
      .target("providers", { config: "one" }, { eager: true })
      .install();
    host.hello();
    await render(<Reader target="providers" />);
    expect(document.body.textContent).toBe('{"config":"one"}');
    await act(async () => host.set("providers", { config: "two" }));
    expect(document.body.textContent).toBe('{"config":"two"}');
  });

  it("waits for the first snapshot of a target hello did not carry", async () => {
    const host = new FakeHost().target("agents", { list: [] }).install();
    await render(<Reader target="agents" />);
    expect(document.body.textContent).toBe("loading");
    await act(async () => host.hello());
    expect(document.body.textContent).toBe('{"list":[]}');
  });
});

describe("the connection", () => {
  it("is lost from the moment it drops until the host says hello again", async () => {
    const host = new FakeHost().install();
    host.hello();
    await render(<Lost />);
    expect(document.body.textContent).toBe("ok");
    await act(async () => host.socket.drop());
    expect(document.body.textContent).toBe("lost");
  });

  it("is not lost while the first connection is still being made", async () => {
    new FakeHost().install();
    await render(<Lost />);
    expect(document.body.textContent).toBe("ok");
  });
});

describe("calling", () => {
  it("resolves with the reply, and fails with words the user can read", async () => {
    const outcomes: string[] = [];
    const host = new FakeHost()
      .handle("providers.save", () => ({ revision: "r2" }))
      .install();
    host.hello();
    await render(<Save onDone={(outcome) => outcomes.push(outcome)} />);
    const press = () =>
      act(async () => document.querySelector("button")!.click());
    await press();
    expect(outcomes).toEqual(["r2"]);

    host.handle("providers.save", () => {
      throw new Error("config_changed");
    });
    await press();
    expect(outcomes.at(-1)).toBe("config_changed");

    await act(async () => host.socket.drop());
    await press();
    expect(outcomes.at(-1)).toBe("与宿主的连接已断开。");
  });
});

describe("what a failure says", () => {
  it("is the host's own message, unless the wire is what failed", () => {
    expect(wireErrorMessage(new WireError("server", "no such provider"))).toBe(
      "no such provider",
    );
    expect(wireErrorMessage(new WireError("disconnected", "x"))).toBe(
      "与宿主的连接已断开。",
    );
    expect(wireErrorMessage(new WireError("timeout", "x"))).toBe(
      "宿主没有及时回应。",
    );
    expect(wireErrorMessage(new Error("boom"))).toBe("boom");
    expect(wireErrorMessage("boom")).toBe("请求失败，请稍后再试。");
  });
});
