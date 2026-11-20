import { Buffer } from "node:buffer";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeEmailMeta } from "../src/email/context";

function headersFor(raw: unknown): Record<string, string> {
  const encoded = gzipSync(Buffer.from(JSON.stringify(raw)), {
    level: 9,
  }).toString("base64url");
  return {
    "X-ETA-Payload-Count": "1",
    "X-ETA-Payload-1": encoded,
  };
}

describe("decodeEmailMeta payload parse", () => {
  it("returns no payload for a body that is not one", () => {
    expect(
      decodeEmailMeta("<p></p>", headersFor("not-an-object")).payload,
    ).toBeNull();
    expect(
      decodeEmailMeta(
        "<p></p>",
        headersFor({ v: 1, payload: { from: { agentId: "a" } } }),
      ).payload,
    ).toBeNull();
    // A protocol with no payload is not a payload with empty fields.
    expect(
      decodeEmailMeta("<p></p>", headersFor({ protocol: "eta-mp/1" })).payload,
    ).toBeNull();
  });

  it("fills missing payload fields with the existing defaults", () => {
    const meta = decodeEmailMeta(
      "<p></p>",
      headersFor({ protocol: "eta-mp/1", payload: {} }),
    );
    expect(meta.payload).toEqual({
      protocol: "eta-mp/1",
      v: 1,
      createdAt: new Date(0).toISOString(),
      from: {
        agentId: null,
        agentName: null,
        sessionId: null,
        conversationId: null,
        taskId: null,
        cwd: null,
        mailThreadId: null,
      },
      work: { doing: null, repo: null, branch: null, paths: [] },
      ask: { question: null, needed: null, by: null },
      decided: [],
      human: { note: null, edited: false },
    });
  });
});
