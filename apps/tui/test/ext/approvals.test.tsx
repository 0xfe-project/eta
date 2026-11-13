/**
 * `/approvals` against a real host: the list of tools that ask first, read from the `inbox` target
 * and replaced whole through `inbox.setApprovals`.
 */
import type { ApprovalList } from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import approvals from "../../src/ext/approvals";
import { observeHost } from "../ext-support/host-observer";
import { recordCalls } from "../ext-support/record-calls";
import { renderWithHost } from "../ext-support/render-with-host";
import { KEYS } from "../ui-support/render";

const DELETE_KEY = "\u001B[3~";
const SET = "inbox.setApprovals";

/** The interface on a host whose list is `tools`, with `/approvals` open. */
async function opened(tools: string[] = []) {
  const r = await renderWithHost({ extensions: [approvals] });
  const host = await observeHost(r.host);
  const hostTools = () =>
    host.section<ApprovalList>("inbox", "approvals")?.tools;
  if (tools.length > 0) {
    await host.client.call("inbox", "setApprovals", { tools });
    await host.until(() => hostTools()?.length === tools.length);
  }
  const calls = recordCalls(r.wire);
  await r.runCommand("/approvals");
  await r.waitFor("Tools that ask first");
  const sets = () => calls.filter((call) => call.op === SET);
  return { r, host, hostTools, sets };
}

async function add(r: Awaited<ReturnType<typeof opened>>["r"], name: string) {
  await r.press("a");
  await r.waitFor("Tool name");
  await r.press(KEYS.paste(name));
  await r.press(KEYS.enter);
}

describe("/approvals", () => {
  it("says every tool runs without asking when the list is empty, and what the list does", async () => {
    const { r } = await opened();
    await r.waitFor("None: every tool runs without asking.");
    expect(r.screen()).toContain("Applies to every conversation");
    expect(r.screen()).toContain("a add");
    expect(r.screen()).toContain("d delete");
    expect(r.screen()).toContain("Esc close");
  });

  it("lists the host's tools", async () => {
    const { r } = await opened(["bash", "write_file"]);
    await r.waitFor("write_file");
    expect(r.screen()).toContain("bash");
    expect(r.screen()).not.toContain("None: every tool runs without asking.");
  });

  it("adds a tool, and the host's list has it", async () => {
    const { r, host, hostTools } = await opened();
    await add(r, "  bash  ");
    await r.waitForGone("Tool name");
    await host.until(() => hostTools()?.join(",") === "bash");
    await r.waitFor(/› bash/);
  });

  it("sends the whole list, so the tools already there stay", async () => {
    const { r, host, hostTools, sets } = await opened(["alpha"]);
    await add(r, "beta");
    await host.until(() => hostTools()?.join(",") === "alpha,beta");
    expect(sets().map((call) => call.args)).toEqual([
      { tools: ["alpha", "beta"] },
    ]);
  });

  it("deletes the marked tool with d, and with Delete", async () => {
    const { r, host, hostTools } = await opened(["alpha", "beta", "gamma"]);
    await r.waitFor("gamma");
    await r.press(KEYS.down);
    await r.press("d");
    await host.until(() => hostTools()?.join(",") === "alpha,gamma");
    await r.waitForGone("beta");
    // The marker stays where beta was, which is gamma now.
    await r.press(DELETE_KEY);
    await host.until(() => hostTools()?.join(",") === "alpha");
    await r.waitForGone("gamma");
  });

  it("does not send a name that is already in the list, and says so", async () => {
    const { r, hostTools, sets } = await opened(["alpha"]);
    await add(r, "alpha");
    await r.waitFor("alpha is already in the list");
    expect(sets()).toEqual([]);
    expect(hostTools()).toEqual(["alpha"]);
  });

  it("shows the host's own words when the host refuses the list", async () => {
    const full = Array.from(
      { length: 200 },
      (_, i) => `tool${String(i).padStart(3, "0")}`,
    );
    const { r, hostTools, sets } = await opened(full);
    await add(r, "one-more");
    await r.waitFor("inbox.setApprovals: that is too long a list");
    expect(sets()).toHaveLength(1);
    expect(hostTools()).toHaveLength(200);
    // Still asking, with what was typed, so it can be changed or given up.
    expect(r.screen()).toContain("Tool name");
    expect(r.screen()).toMatch(/› one-more/);
  });

  it("goes back to the list on Esc while adding, and closes on Esc", async () => {
    const { r } = await opened(["alpha"]);
    await r.press("a");
    await r.waitFor("Tool name");
    await r.press(KEYS.escape);
    await r.waitForGone("Tool name");
    expect(r.screen()).toContain("Tools that ask first");
    await r.press(KEYS.escape);
    await r.waitForGone("Tools that ask first");
  });

  it("follows a change another client makes", async () => {
    const { r, host } = await opened(["alpha"]);
    await host.client.call("inbox", "setApprovals", {
      tools: ["alpha", "zeta"],
    });
    await r.waitFor("zeta");
  });
});
