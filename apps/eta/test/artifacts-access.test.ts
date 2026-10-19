import { writeFile } from "node:fs/promises";
/**
 * The token gate and the artifact pages: `/preview/` and `/share/` are open because they carry
 * their own capability, and nothing else is opened by that.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir, testHost } from "./support/host";

const TOKEN = "a-long-enough-test-token";

async function gated() {
  const dir = await tempDir();
  const tokenFile = join(dir, "token");
  await writeFile(tokenFile, TOKEN);
  const host = await testHost({ tokenFile });
  return { base: `http://127.0.0.1:${host.port}` };
}

describe("the token gate and artifact pages", () => {
  it("lets /preview/ and /share/ answer for themselves, found or not, without a token", async () => {
    const { base } = await gated();
    // The answer is the page's own 404 (or 405), not the gate's 401.
    expect((await fetch(`${base}/preview/x/files/index.html`)).status).toBe(
      404,
    );
    expect((await fetch(`${base}/share/x/`)).status).toBe(404);
    expect((await fetch(`${base}/share/x/archive.zip`)).status).toBe(404);
    expect((await fetch(`${base}/share/x/files/a`)).status).toBe(404);
  });

  it("keeps everything else behind the token, including the app's own downloads and writes", async () => {
    const { base } = await gated();
    for (const path of [
      "/artifacts/x/1/archive.zip",
      "/preview",
      "/previews/x",
      "/share",
      "/sharing/x",
      "/",
      "/version",
      "/ws",
    ]) {
      expect((await fetch(base + path)).status, path).toBe(401);
    }
    // Only reads are exempt.
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect((await fetch(`${base}/share/x/`, { method })).status, method).toBe(
        401,
      );
    }
    // A dot-segment cannot walk out of the exempt prefix.
    expect((await fetch(`${base}/share/%2e%2e/version`)).status).toBe(401);
    expect((await fetch(`${base}/share/../version`)).status).toBe(401);
    // With the token the download is the app's.
    const withToken = await fetch(`${base}/artifacts/x/1/archive.zip`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(withToken.status).toBe(404);
    expect((await fetch(`${base}/up`)).status).toBe(200);
  });
});
