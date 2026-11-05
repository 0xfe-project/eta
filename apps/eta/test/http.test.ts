/** The HTTP side of the host: the built web, `/up` and `/version`. */
import { connect as dial } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { embedResources, resource, resourceNames } from "../src/resources";
import { connect } from "./support/client";
import { fakeWeb, testHost } from "./support/host";

describe("serving the web", () => {
  it("serves index.html at the root and for client routes, without caching it", async () => {
    const host = await testHost({ webDir: await fakeWeb() });
    const origin = `http://127.0.0.1:${host.port}`;
    for (const path of ["/", "/index.html", "/workspace/tasks/12"]) {
      const response = await fetch(`${origin}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(await response.text()).toContain("<title>eta</title>");
    }
  });

  it("serves assets with a long cache and other files revalidated", async () => {
    const host = await testHost({ webDir: await fakeWeb() });
    const origin = `http://127.0.0.1:${host.port}`;
    const asset = await fetch(`${origin}/assets/app-abc123.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(asset.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(await asset.text()).toBe("console.log(1)");
    // A file outside assets/ keeps its name across builds (a service worker above all), so it
    // is checked every time.
    const worker = await fetch(`${origin}/sw.js`);
    expect(await worker.text()).toBe("// service worker");
    expect(worker.headers.get("cache-control")).toBe("no-cache");
  });

  it("answers a missing asset with 404, not with the page", async () => {
    const host = await testHost({ webDir: await fakeWeb() });
    const response = await fetch(
      `http://127.0.0.1:${host.port}/assets/gone-0000.js`,
    );
    expect(response.status).toBe(404);
  });

  it("does not leave the directory", async () => {
    const host = await testHost({ webDir: await fakeWeb() });
    const origin = `http://127.0.0.1:${host.port}`;
    for (const path of [
      "/%2e%2e/%2e%2e/etc/passwd",
      "/..%2f..%2fetc/passwd",
      "/%2e%2e%5c%2e%2e%5cetc%5cpasswd",
      "/assets/..%2f..%2f..%2fetc%2fpasswd",
    ]) {
      const response = await fetch(`${origin}${path}`);
      // The page or a refusal; never a file from outside the directory.
      expect(await response.text()).not.toContain("root:");
    }
    expect((await fetch(`${origin}/%zz`)).status).toBe(400);

    // A client library tidies the path before it is sent; a raw request does not.
    const raw = await new Promise<string>((resolve, reject) => {
      let received = "";
      const socket = dial(host.port, "127.0.0.1", () =>
        socket.write(
          "GET /../../../../../../etc/passwd HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
        ),
      );
      socket.on("data", (chunk) => (received += String(chunk)));
      socket.on("end", () => resolve(received));
      socket.on("error", reject);
    });
    expect(raw).not.toContain("root:");
  });

  it("never answers the socket's path with the page", async () => {
    const host = await testHost({ webDir: await fakeWeb() });
    const response = await fetch(`http://127.0.0.1:${host.port}/ws`);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("websocket upgrade failed");
    // And the socket works on a host that serves a page.
    const client = await connect(`ws://127.0.0.1:${host.port}/ws`);
    expect((await client.hello()).type).toBe("hello");
    client.close();
  });

  it("only serves files for reads", async () => {
    const host = await testHost({ webDir: await fakeWeb() });
    const response = await fetch(`http://127.0.0.1:${host.port}/`, {
      method: "POST",
      body: "x",
    });
    expect(response.status).toBe(404);
  });
});

describe("/up and /version", () => {
  it("answers /up with ok, with or without a web", async () => {
    for (const webDir of [undefined, await fakeWeb()]) {
      const host = await testHost(webDir === undefined ? {} : { webDir });
      const response = await fetch(`http://127.0.0.1:${host.port}/up`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
    }
  });

  it("answers /version with the build id next to index.html, read per request", async () => {
    const dir = await fakeWeb("build-one");
    const host = await testHost({ webDir: dir });
    const url = `http://127.0.0.1:${host.port}/version`;
    const first = await fetch(url);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("build-one");
    expect(first.headers.get("cache-control")).toBe("no-store");

    // A rebuild under a running host is visible without a restart.
    await Bun.write(`${dir}/BUILD`, "build-two\n");
    expect(await (await fetch(url)).text()).toBe("build-two");
  });

  it("answers /version with 404 when there is no bundle or no id", async () => {
    const bare = await testHost();
    expect((await fetch(`http://127.0.0.1:${bare.port}/version`)).status).toBe(
      404,
    );
    const noId = await testHost({ webDir: await fakeWeb(null) });
    expect((await fetch(`http://127.0.0.1:${noId.port}/version`)).status).toBe(
      404,
    );
  });

  it("answers nothing but /up and the socket on a host without a web", async () => {
    const host = await testHost();
    for (const path of ["/", "/workspace", "/assets/app.js"]) {
      expect((await fetch(`http://127.0.0.1:${host.port}${path}`)).status).toBe(
        404,
      );
    }
  });
});

describe("the page a compiled host carries", () => {
  afterEach(() => {
    embedResources(undefined);
  });

  /** A page embedded the way a compiled host has it: nothing is called what it was. */
  async function carried(): Promise<void> {
    const dir = await fakeWeb();
    const migrations = Object.fromEntries(
      resourceNames("migrations").map((name) => [name, resource(name)]),
    );
    embedResources({
      files: {
        ...migrations,
        "web/index.html": join(dir, "index.html"),
        "web/assets/app-abc123.js": join(dir, "assets", "app-abc123.js"),
        "web/sw.js": join(dir, "sw.js"),
        "web/BUILD": join(dir, "BUILD"),
      },
      digests: {},
    });
  }

  it("answers like a directory: types, cache headers, client routes, missing assets", async () => {
    await carried();
    const host = await testHost();
    const origin = `http://127.0.0.1:${host.port}`;

    for (const path of ["/", "/index.html", "/workspace/tasks/12"]) {
      const page = await fetch(`${origin}${path}`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(page.headers.get("cache-control")).toBe("no-cache");
      expect(await page.text()).toContain("<title>eta</title>");
    }

    const asset = await fetch(`${origin}/assets/app-abc123.js`);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(asset.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(await asset.text()).toBe("console.log(1)");

    const worker = await fetch(`${origin}/sw.js`);
    expect(worker.headers.get("cache-control")).toBe("no-cache");

    expect((await fetch(`${origin}/assets/gone-0000.js`)).status).toBe(404);
    expect(
      (await fetch(`${origin}/assets`)).headers.get("content-type"),
    ).toContain("text/html");
    expect(await (await fetch(`${origin}/version`)).text()).toBe("b1");
  });

  it("has nothing outside the page to give", async () => {
    await carried();
    const host = await testHost();
    const response = await fetch(
      `http://127.0.0.1:${host.port}/%2e%2e/%2e%2e/etc/passwd`,
    );
    expect(await response.text()).not.toContain("root:");
  });

  it("gives way to --web-dir", async () => {
    await carried();
    const dir = await fakeWeb("from-the-directory");
    const host = await testHost({ webDir: dir });
    const response = await fetch(`http://127.0.0.1:${host.port}/version`);
    expect(await response.text()).toBe("from-the-directory");
  });
});
