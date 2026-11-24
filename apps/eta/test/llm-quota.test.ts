import type { CpaClient } from "@cpajs/cpa/client";
import type { Connection } from "../src/llm/state";
import { describe, expect, it, vi } from "vitest";
import { Codex } from "../src/llm/codex";
import { Gateway } from "../src/llm/gateway";
import { LlmError } from "../src/llm/problems";
import { selectSourceQuota } from "../src/llm/source-quota";
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

describe("monthly summaries", () => {
  it("binds fresh results to each account, excludes ambiguous windows and leaves health alone on refusal", async () => {
    const metadata = {
      created_at: "2026-01-01",
      name: "fixture",
      provider: "codex",
      status: "active",
    };
    let revision = "2026-01-01";
    const refresh = vi.fn();
    const cpa = {
      credentials: {
        list: async () => ({
          files: ["one", "two"].map((auth_index) => ({
            ...metadata,
            auth_index,
            updated_at: revision,
          })),
        }),
        refresh,
      },
      config: { getPath: async () => ({ data: {} }) },
    } as unknown as CpaClient;
    const connector = new Codex({ cpa: () => cpa, warn: vi.fn() });
    const month = { kind: "monthly" as const, used: 0 };
    const paused = Promise.withResolvers<void>();
    let phase = 0;
    const usage = vi
      .spyOn(connector, "usage")
      .mockImplementation(async (connection) => {
        if (phase === 1) await paused.promise;
        if (connection.id === "two") return { windows: [month, month] };
        if (phase === 2)
          throw new LlmError("login_expired", "private upstream text");
        return { windows: [{ ...month, used: phase === 3 ? 3 : 0 }] };
      });
    const gateway = new Gateway({
      cpa: () => cpa,
      connectors: [connector],
      catalogPath: "/unused-eta-test-catalog",
    });
    const warn = vi.fn();
    const read = () => gateway.monthlySummaries((work) => work(), warn);
    const original = await gateway.connections();
    expect((await read()).map((i) => i.value)).toEqual([
      { monthly: { usedPercent: 0 } },
      null,
    ]);
    phase = 1;
    const first = read();
    const second = read();
    await vi.waitFor(() => expect(usage).toHaveBeenCalledTimes(4));
    paused.resolve();
    expect(await first).toEqual(await second);
    expect(usage).toHaveBeenCalledTimes(4);
    phase = 2;
    expect((await read()).map((i) => i.value)).toEqual([null, null]);
    expect((await read()).map((i) => i.value)).toEqual([null, null]);
    expect(usage.mock.calls.filter(([c]) => c.id === "one")).toHaveLength(3);
    expect(refresh).not.toHaveBeenCalled();
    expect(await gateway.connections()).toEqual(original);
    expect(warn.mock.calls.flat().join(" ")).toMatch(
      /failure=login_expired retry=credential_change/,
    );
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/private|fixture/);
    phase = 3;
    revision = "2026-02-01";
    expect((await read())[0]).toMatchObject({
      value: { monthly: { usedPercent: 3 } },
    });
  });
});

describe("source quota selection", () => {
  const now = Date.parse("2026-11-24T00:00:00Z");
  const resetsAt = "2026-11-27T10:15:00.000Z";
  const week = {
    kind: "weekly" as const,
    durationSeconds: 604800,
    used: 17,
    resetsAt,
  };
  const month = { kind: "monthly" as const, durationSeconds: 2592000, used: 0 };
  const fiveHours = { kind: "5h" as const, durationSeconds: 18000, used: 99 };

  it.each([-3600, 0, 3600])(
    "prefers a verified week at offset %s",
    (offset) => {
      expect(
        selectSourceQuota(
          [
            fiveHours,
            month,
            month,
            { ...week, durationSeconds: 604800 + offset },
          ],
          now,
        ),
      ).toEqual({ period: "weekly", usedPercent: 17, resetsAt });
    },
  );

  it("leaves the row blank without a verified week, a month included", () => {
    expect(selectSourceQuota([fiveHours, month], now)).toBeNull();
    expect(selectSourceQuota([fiveHours], now)).toBeNull();
    expect(
      selectSourceQuota([{ ...week, durationSeconds: 608401 }, month], now),
    ).toBeNull();
    expect(
      selectSourceQuota([{ kind: "weekly", used: 17 }, month], now),
    ).toBeNull();
    expect(selectSourceQuota([fiveHours, month, month], now)).toBeNull();
  });

  it("leaves ambiguous or unusable weekly values blank, even with a valid month", () => {
    expect(selectSourceQuota([week, week, month], now)).toBeNull();
    expect(selectSourceQuota([{ ...week, used: NaN }, month], now)).toBeNull();
    expect(selectSourceQuota([week, month], Date.parse(resetsAt))).toBeNull();
  });
});
