import type { CpaClient } from "@cpajs/cpa/client";
import type { Connection } from "../src/llm/state";
import { describe, expect, it, vi } from "vitest";
import { Codex } from "../src/llm/codex";
import { XAI } from "../src/llm/xai";

const account: Connection = {
  id: "account",
  connector: "codex",
  label: "Account",
  state: "active",
  authIndex: "account",
  source: { kind: "file", name: "login", accountId: "workspace" },
  createdAt: "2026-01-01",
  cooldowns: [],
};

describe("subscription quota adapters", () => {
  it.each([undefined, null, "", -1, 101, 0, 37.5])(
    "accepts only verified upstream percentage %s",
    async (used) => {
      const months = 30 * 86400;
      const apiCall = vi.fn(async ({ auth_index, url, header }) => {
        expect(auth_index).toBe("account");
        let body: unknown = {};
        if (url.endsWith("/usage")) {
          expect(header["ChatGPT-Account-Id"]).toBe("workspace");
          body = {
            rate_limit: {
              primary_window: { used_percent: 80, limit_window_seconds: 18000 },
              secondary_window: {
                used_percent: used,
                limit_window_seconds: months,
              },
            },
          };
        } else if (url.includes("/billing"))
          body = {
            config: {
              creditUsagePercent: used,
              currentPeriod: {
                start: "2026-11-01T00:00:00Z",
                end: "2026-12-01T00:00:00Z",
              },
            },
          };
        return { status_code: 200, body: JSON.stringify(body) };
      });
      const context = {
        cpa: () => ({ requests: { apiCall } }) as unknown as CpaClient,
        warn: vi.fn(),
      };
      for (const connector of [new Codex(context), new XAI(context)]) {
        const { windows } = await connector.usage(
          account,
          new AbortController().signal,
        );
        const monthly = windows.filter((item) => item.kind === "monthly");
        if (used === 0 || used === 37.5)
          expect(monthly).toMatchObject([{ used, durationSeconds: months }]);
        else expect(monthly).toEqual([]);
        if (connector instanceof Codex)
          expect(windows[0]).toMatchObject({ kind: "5h", used: 80 });
      }
    },
  );
});
