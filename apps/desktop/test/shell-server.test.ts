import type { Choice, View } from "../src/bun/shell";
import type { ShellServer } from "../src/bun/shell-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startShellServer } from "../src/bun/shell-server";

const secretView: View = {
  screen: "failure",
  connection: { mode: "remote", address: "https://h", token: "secret" },
  failure: { reason: "lost" },
};

let server: ShellServer;
afterEach(() => {
  server.close();
});

function start(view: View | undefined = secretView) {
  const options = {
    view: () => view,
    choose: vi.fn(async (_choice: Choice) => undefined),
    retry: vi.fn(async () => ({ reason: "unreachable" as const })),
    openChooser: vi.fn(),
    back: vi.fn(),
  };
  server = startShellServer(options);
  return options;
}

const call = (path: string, body?: unknown, origin = server.origin) =>
  fetch(`${server.origin}/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${server.token}`,
      origin,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("the shell's page", () => {
  it("is served to anyone, because it holds nothing", async () => {
    start();
    const page = await fetch(server.origin);
    expect(page.headers.get("content-type")).toContain("text/html");
    const text = await page.text();
    expect(text).toContain('id="address"');
    expect(text).not.toContain(server.token);
  });

  it("hears where the host is, never the token", async () => {
    start();
    const text = await (await call("view")).text();
    expect(text).toContain("https://h");
    expect(text).not.toContain("secret");
  });

  it("refuses a call without the token", async () => {
    const options = start();
    const answer = await fetch(`${server.origin}/api/choose`, {
      method: "POST",
      headers: { origin: server.origin },
      body: JSON.stringify({ mode: "local" }),
    });
    expect(answer.status).toBe(401);
    expect(options.choose).not.toHaveBeenCalled();
  });

  it("refuses another page's call, even with the token", async () => {
    const options = start();
    const answer = await call(
      "choose",
      { mode: "local" },
      "https://mac.ts.net",
    );
    expect(answer.status).toBe(403);
    expect(options.choose).not.toHaveBeenCalled();
  });

  it("refuses a change with no origin at all, which is not the page", async () => {
    const options = start();
    const answer = await fetch(`${server.origin}/api/choose`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ mode: "local" }),
    });
    expect(answer.status).toBe(403);
    expect(options.choose).not.toHaveBeenCalled();
  });

  it("passes a choice on", async () => {
    const options = start();
    const choice = { mode: "remote", address: "h", token: "t" };
    await expect((await call("choose", choice)).json()).resolves.toEqual({
      ok: true,
    });
    expect(options.choose).toHaveBeenCalledWith(choice);
  });

  it("refuses what is not a choice", async () => {
    const options = start();
    expect((await call("choose", { mode: "remote" })).status).toBe(400);
    expect(options.choose).not.toHaveBeenCalled();
  });

  it("says how a retry went", async () => {
    start();
    await expect((await call("retry", {})).json()).resolves.toEqual({
      ok: false,
      failure: { reason: "unreachable" },
    });
  });

  it("splits a pasted link", async () => {
    start();
    const answer = await call("link", {
      text: "eta://connect?address=https%3A%2F%2Fh&token=t",
    });
    await expect(answer.json()).resolves.toEqual({
      address: "https://h",
      token: "t",
    });
    await expect(
      (await call("link", { text: "nothing" })).json(),
    ).resolves.toBeNull();
  });

  it("opens the chooser and goes back", async () => {
    const options = start();
    await call("chooser", {});
    await call("back", {});
    expect(options.openChooser).toHaveBeenCalledOnce();
    expect(options.back).toHaveBeenCalledOnce();
  });
});
