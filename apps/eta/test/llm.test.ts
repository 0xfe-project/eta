/**
 * The LLM gateway in the real host, against a fake upstream: the gateway's models appear on the
 * wire and in the model layer, a generation through them streams and is billed, a client that
 * stops cancels the upstream, and an upstream failure is that generation's, not the host's.
 *
 * The gateway is the real CLIProxyAPI (a child process); only the provider it would call is
 * fake.
 */
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { LlmAccounts, LlmModel, LlmQuota } from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import { entryOf } from "../src/usage/recorder";
import { connect, until } from "./support/client";
import { cpaExtraFor, fakeUpstream, MODEL } from "./support/fake-upstream";
import { testHost } from "./support/host";

const ask = (text: string): Context => ({
  messages: [{ role: "user", content: text, timestamp: Date.now() }],
});

describe.skipIf(process.platform === "win32")(
  "the LLM gateway in the host",
  () => {
    it("serves its models, generates through them, bills the tokens and survives failures", async () => {
      const upstream = fakeUpstream();
      try {
        const host = await testHost({
          llm: { cpaExtra: cpaExtraFor(upstream) },
        });
        const client = await connect(`ws://127.0.0.1:${host.port}/ws`);
        const hello = await client.hello();
        expect(hello.mounted.map((plugin) => plugin.name)).toContain("llm");

        // The accounts and the catalog are on the wire.
        client.subscribe("llm");
        await until(
          () => client.section<LlmAccounts>("llm", "accounts")?.ready === true,
        );
        const accounts = client.section<LlmAccounts>("llm", "accounts")!;
        expect(accounts.connectors.map((connector) => connector.id)).toEqual([
          "codex",
          "xai",
          "gemini",
        ]);
        expect(
          accounts.connectors.find((connector) => connector.id === "xai")?.flow,
        ).toBe("oauth_device");
        expect(
          accounts.connectors.find((connector) => connector.id === "gemini")
            ?.flow,
        ).toBe("api_key");
        await until(
          () =>
            client
              .section<LlmModel[]>("llm", "models")
              ?.some((model) => model.id === MODEL && model.available) === true,
        );
        // An API key has no subscription window to report.
        await until(
          () => client.section<LlmQuota[]>("llm", "quota")?.length === 1,
        );
        expect(client.section<LlmQuota[]>("llm", "quota")![0]!.windows).toEqual(
          [],
        );

        // A refusal reaches the client as the gateway's code (and params), untranslated; the
        // message is an English diagnostic.
        await expect(
          client.call("llm", "loginPoll", { id: "no-such-login" }),
        ).rejects.toThrow("Not found.");
        const refusals = client.frames.filter(
          (frame) => frame.type === "reply" && !frame.ok,
        ) as { error: string; problem?: { code: string } }[];
        expect(refusals.at(-1)?.problem).toEqual({ code: "not_found" });

        // The model layer answers for `llm:<model>`.
        const models = host.server.models;
        const model = models.getModel("llm", MODEL);
        expect(model).toBeDefined();

        // A generation streams through CPA to the fake and back, with the tokens it reported.
        const events: string[] = [];
        const stream = models.streamSimple(model!, ask("hi"), {});
        for await (const event of stream) events.push(event.type);
        const message: AssistantMessage = await stream.result();
        expect(message.stopReason).toBe("stop");
        expect(
          message.content.map((part) =>
            part.type === "text" ? part.text : "",
          ),
        ).toEqual(["Hello from the fake"]);
        expect(
          events.filter((type) => type === "text_delta").length,
        ).toBeGreaterThan(1);
        expect(message.usage.input).toBe(5);
        expect(upstream.userAgents.at(-1)).toBe("eta/dev");
        // CPA offers Codex models its hosted image tool unless told not to, and the model then
        // tells the user it can draw (`image_gen.imagegen`); eta cannot show what it would draw.
        const sent = JSON.parse(
          upstream.bodies.filter((body) => body.includes('"hi"')).at(-1)!,
        ) as {
          tools?: { type: string }[];
        };
        expect(sent.tools ?? []).not.toContainEqual(
          expect.objectContaining({ type: "image_generation" }),
        );
        expect(message.usage.output).toBe(4);
        // ... and that is what the usage table records for whoever asked.
        const entry = entryOf(
          { id: "s1", agentId: "a1", conversationId: "c1" } as never,
          message,
        );
        expect(entry).toMatchObject({
          provider: "llm",
          model: MODEL,
          input: 5,
          output: 4,
          status: "ok",
          agentId: "a1",
        });

        // A client that stops cancels the upstream request.
        const before = upstream.cancelled;
        const control = new AbortController();
        const slow = models.streamSimple(model!, ask("slow"), {
          signal: control.signal,
        });
        let deltas = 0;
        for await (const event of slow) {
          if (event.type === "text_delta" && ++deltas === 3) control.abort();
        }
        expect((await slow.result()).stopReason).toBe("aborted");
        await until(() => upstream.cancelled > before);

        // An upstream failure is that generation's, not the gateway's.
        for (const prompt of ["fail-500", "fail-429"]) {
          const failed = await models.completeSimple(model!, ask(prompt), {});
          expect(failed.stopReason).toBe("error");
        }
        // CPA cools the model down after a failure, so the next generation may be refused too;
        // what must hold is that the gateway still answers for its catalog and its accounts.
        const catalog = await host.llm!.gateway.models();
        expect(catalog.map((entry) => entry.id)).toContain(MODEL);
        expect(await host.llm!.gateway.connections()).toHaveLength(1);

        // Everything else about the host is as it was: the configured providers still answer for their own models.
        expect(models.getModel("acme", "m1")?.provider).not.toBe("llm");
      } finally {
        upstream.stop();
      }
    }, 120_000);
  },
);
