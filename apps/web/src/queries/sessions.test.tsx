import { afterEach, describe, expect, it } from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import { cleanup, flush, mount } from "@/test-render";
import { FakeHost } from "@/test-wire";
import { useRunBlocks, useSession } from "./sessions";

function Numbers({ id }: { id: string | null }) {
  const session = useSession(id);
  return <output>{session?.model?.id ?? "…"}</output>;
}

function Run({ id }: { id: string }) {
  const blocks = useRunBlocks(id);
  return (
    <output>
      {blocks
        .map((block) =>
          block.type === "tool" ? `tool:${block.name}` : block.text,
        )
        .join("|")}
    </output>
  );
}

const sections = (extra: Record<string, unknown> = {}) => ({
  core: { session: "s1", running: false },
  model: { id: "p:m", thinkingLevel: "off" },
  transcript: { messages: [] },
  ...extra,
});

function sessionHost() {
  const host = new FakeHost().target("sessions.s1", sections()).install();
  host.handle("sessions.resync", () => ({}));
  host.hello();
  return host;
}

afterEach(async () => {
  await cleanup();
  setWire(undefined);
});

describe("a member's session", () => {
  it("is opened, then subscribed to, and shows its view", async () => {
    const host = sessionHost();
    await mount(<Numbers id="s1" />);
    await flush();
    expect(host.calls.map((c) => `${c.target}.${c.action}`)).toEqual([
      "sessions.resync",
    ]);
    expect(
      host.socket.framesOf("subscribe").map((frame) => frame.target),
    ).toEqual(["sessions.s1"]);
    expect(document.body.textContent).toBe("p:m");
  });

  it("asks for nothing for a member that has no session yet", async () => {
    const host = sessionHost();
    await mount(<Numbers id={null} />);
    await flush();
    expect(host.calls).toEqual([]);
    expect(host.socket.framesOf("subscribe")).toEqual([]);
    expect(document.body.textContent).toBe("…");
  });
});

describe("the run in flight", () => {
  it("grows with the message events, since the view only says that a message is streaming", async () => {
    const host = sessionHost();
    await mount(<Run id="s1" />);
    await flush();
    const speak = (text: string) =>
      host.socket.receive({
        type: "event",
        target: "sessions.s1",
        name: "message:update",
        data: {
          message: {
            role: "assistant",
            content: [{ type: "text", text }],
            timestamp: 5,
          },
        },
      });
    await act(async () => speak("Hel"));
    await flush(60);
    expect(document.body.textContent).toBe("Hel");
    await act(async () => speak("Hello there"));
    await flush(60);
    expect(document.body.textContent).toBe("Hello there");

    await act(async () =>
      host.socket.receive({
        type: "event",
        target: "sessions.s1",
        name: "turn:run-end",
        data: {},
      }),
    );
    await flush(60);
    expect(document.body.textContent).toBe("");
  });

  it("draws the tool calls the transcript already holds", async () => {
    const host = sessionHost();
    await mount(<Run id="s1" />);
    await flush();
    await act(async () =>
      host.set(
        "sessions.s1",
        sections({
          transcript: {
            messages: [
              {
                entryId: "e1",
                seq: 1,
                at: 1,
                message: { role: "user", content: "go", timestamp: 1 },
              },
              {
                entryId: "e2",
                seq: 2,
                at: 2,
                message: {
                  role: "assistant",
                  timestamp: 2,
                  content: [
                    { type: "toolCall", id: "t", name: "bash", arguments: {} },
                  ],
                },
              },
            ],
          },
        }),
      ),
    );
    expect(document.body.textContent).toBe("tool:bash");
  });
});
