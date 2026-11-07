/**
 * GitHub's release API over a directory of builds, as far as `eta-host upgrade` uses it:
 * `<root>/<version>/` is a release, `latest` the highest without a `-`, or what `<root>/latest`
 * says. An asset's address redirects to a signed one that refuses a credential, like GitHub's.
 *
 *   bun scripts/upgrade-e2e/fake-releases.ts <builds> [port]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const root = process.argv[2] ?? "builds";
const port = Number(process.argv[3] ?? 9900);

const versions = () => readdirSync(root).filter((name) => /^\d/.test(name));

function pinned(): string | undefined {
  const file = join(root, "latest");
  return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
}

const release = (origin: string, version: string): Response =>
  Response.json({
    tag_name: `v${version}`,
    draft: false,
    prerelease: version.includes("-"),
    assets: readdirSync(join(root, version))
      .filter((name) => name === "SHA256SUMS" || name.startsWith("eta-host-"))
      .map((name) => ({
        name,
        url: `${origin}/repos/o/r/releases/assets/${version}/${name}`,
        browser_download_url: "unused",
      })),
  });

Bun.serve({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  fetch(request) {
    const { origin, pathname } = new URL(request.url);
    if (pathname.startsWith("/signed/")) {
      if (request.headers.has("authorization"))
        return new Response("a signed address refuses a credential", {
          status: 400,
        });
      return new Response(Bun.file(join(root, pathname.slice(8))));
    }
    if (pathname === "/repos/o/r/releases/latest") {
      const full = versions().filter((version) => !version.includes("-"));
      const version = pinned() ?? full.sort(Bun.semver.order).at(-1);
      return version === undefined
        ? new Response("Not Found", { status: 404 })
        : release(origin, version);
    }
    const tag = /^\/repos\/o\/r\/releases\/tags\/v(.+)$/.exec(pathname)?.[1];
    if (tag !== undefined && existsSync(join(root, tag)))
      return release(origin, tag);
    const asset = /^\/repos\/o\/r\/releases\/assets\/(.+)$/.exec(pathname)?.[1];
    if (asset !== undefined)
      return new Response(null, {
        status: 302,
        headers: { location: `${origin}/signed/${asset}` },
      });
    return new Response("Not Found", { status: 404 });
  },
});
console.log(`fake releases of ${root} on ${port}`);
