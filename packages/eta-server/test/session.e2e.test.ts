/**
 * A real turn through the server layer (REFACTOR.md §5b).
 *
 * Skipped unless a configuration file is named, so the normal suite stays offline
 * and deterministic:
 *
 *   ETA_SMOKE_CONFIG=~/.eta/config.json bun run --cwd packages/eta-server smoke
 *   ETA_SMOKE_MODEL=provider:model   (defaults to the file's own defaultModel)
 *
 * Nothing about the endpoint is hardcoded: provider, base URL, key and model come
 * from that file. What this proves that the scripted fakes cannot is the whole
 * server path — a session created by the manager, a real stream off a real model,
 * a real usage number on disk, and a reopen that answers from the replayed
 * transcript rather than from a live object.
 */

import { realModels, selectProvider } from "@eta/core/testing";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/manager";
import { MemorySessionStore } from "../src/memory-store";

const configPath = process.env.ETA_SMOKE_CONFIG;
const modelSelector = process.env.ETA_SMOKE_MODEL;
const TIMEOUT_MS = Number(process.env.ETA_SMOKE_TIMEOUT_MS ?? 180_000);

describe.skipIf(configPath === undefined)(
  "a real session through the manager",
  () => {
    it(
      "creates a session, runs a real turn, and finds it again after a reopen",
      async () => {
        const selected = await selectProvider(configPath!, modelSelector);
        const models = realModels(selected.spec);
        const store = new MemorySessionStore();
        const sessions = new SessionManager({
          store,
          modelsFor: (meta) => {
            // The session's own model choice has to survive into the request.
            expect(meta.model === undefined || meta.model.length > 0).toBe(
              true,
            );
            return models;
          },
          defaults: { model: `${selected.spec.id}:${selected.modelId}` },
        });

        const created = await sessions.create({
          cwd: process.cwd(),
          title: "smoke",
        });
        expect(created.session.config.model).toEqual({
          provider: selected.spec.id,
          modelId: selected.modelId,
        });

        const secret = `POMELO-${Date.now()}`;
        created.session.kernel.inject({
          role: "user",
          content: [
            {
              type: "text",
              text: `Remember this word: ${secret}. Reply with only the word.`,
            },
          ],
          timestamp: Date.now(),
        });
        const result = await created.session.runner.run();
        expect(result.status).toBe("completed");
        expect(result.error).toBeUndefined();
        await created.session.journaling.flush();

        // What a real model and a real journal must produce.
        const storage = (await store.open(created.meta.id))!.storage;
        const stats = await storage.getStats();
        expect(stats.messageCount).toBeGreaterThanOrEqual(2);
        expect(stats.usage.input).toBeGreaterThan(0);
        expect(stats.usage.totalTokens).toBeGreaterThan(0);
        // The session now installs tools, so a real model may take a few turns (it is
        // free to write a task note before answering): what has to hold is that both
        // sides of the conversation are there, in order, and that it holds the word.
        const transcript = created.session.log.transcript();
        expect(transcript.length).toBeGreaterThanOrEqual(2);
        expect(transcript[0]?.role).toBe("user");
        expect(JSON.stringify(transcript)).toContain(secret);

        // Close the session and ask for it again: the manager assembles a fresh
        // kernel over the journal, and the transcript comes back from disk.
        const id = created.meta.id;
        await sessions.close(id);
        const reopened = await sessions.session(id);
        expect(reopened).toBeDefined();
        // The replay is the transcript: same messages, same order, same count.
        expect(
          reopened!.session.log.transcript().map((message) => message.role),
        ).toEqual(transcript.map((message) => message.role));
        expect(JSON.stringify(reopened!.session.log.transcript())).toContain(
          secret,
        );

        // And it keeps working: a second turn continues the same conversation.
        reopened!.session.kernel.inject({
          role: "user",
          content: [
            {
              type: "text",
              text: "What word did I ask you to remember? Reply with only the word.",
            },
          ],
          timestamp: Date.now(),
        });
        const second = await reopened!.session.runner.run();
        expect(second.status).toBe("completed");
        await reopened!.session.journaling.flush();
        const answers = reopened!.session.log
          .transcript()
          .filter((message) => message.role === "assistant")
          .map((message) => JSON.stringify(message.content));
        expect(answers.join(" ")).toContain(secret);

        await sessions.closeAll();
      },
      TIMEOUT_MS * 2,
    );
  },
);
