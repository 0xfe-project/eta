/**
 * The model layer that reports each request: every one that ends with a message is told, whether
 * it was streamed or completed, and the host's counting can never be what fails a request.
 */
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { observedModels } from "../src/observed-models";

const model = (models: ReturnType<typeof fakeModels>) =>
  models.getModel("fake", "fake-model")!;

describe("observedModels", () => {
  it("tells of a streamed request when it ends, and of a completed one", async () => {
    const told: string[] = [];
    const models = observedModels(
      fakeModels([
        assistantMessage({ content: [{ type: "text", text: "one" }] }),
        assistantMessage({ content: [{ type: "text", text: "two" }] }),
      ]),
      (message) => told.push(message.stopReason),
    );
    const base = fakeModels([]);
    const stream = models.streamSimple(model(base), { messages: [] });
    await stream.result();
    await models.completeSimple(model(base), { messages: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(told).toEqual(["stop", "stop"]);
  });

  it("answers the same when the observer throws", async () => {
    const models = observedModels(
      fakeModels([assistantMessage({ content: [] })]),
      () => {
        throw new Error("the counter is broken");
      },
    );
    const base = fakeModels([]);
    await expect(
      models.completeSimple(model(base), { messages: [] }),
    ).resolves.toMatchObject({ role: "assistant" });
  });
});
