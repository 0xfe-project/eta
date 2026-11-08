/**
 * `/artifacts` on a real host: an agent publishes with its `publish_artifact` tool, the layer
 * lists what the host has, and Enter on one asks for a preview address that the host serves.
 */
import type { RenderedApp } from "../ui-support/app";
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { call, say } from "../../../eta/test/support/models";
import { screenShows } from "../conversation/view-host-world";
import { askedStarting, enter, manageWorld } from "../manage/world";
import { baseUrl } from "../support/host";
import { until } from "../support/temp";
import { KEYS, plain, realDelay } from "../ui-support/render";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

interface ArtifactRow {
  id: string;
  title: string;
  versions: { number: number; shareUrl: string | null }[];
}

/**
 * Ada in a project; every message to her publishes the next title in `titles` from `dist/`
 * (a new artifact each time, or a new version when the title was published before).
 */
async function publishing() {
  const published = new Map<string, string>();
  const plan: { title: string }[] = [];
  let next: { title: string } | undefined;
  const w = await manageWorld((request) => {
    if (request.lastRole === "toolResult") return say("done");
    next = plan.shift();
    if (next === undefined) return say("nothing to publish");
    const artifactId = published.get(next.title);
    return call("publish_artifact", {
      path: "dist",
      title: next.title,
      ...(artifactId === undefined ? {} : { artifactId }),
    });
  });
  const ada = await w.agent("Ada");
  const project = await w.project(ada.id);
  await mkdir(join(project.path, "dist"), { recursive: true });
  await writeFile(join(project.path, "dist", "index.html"), "<h1>hello</h1>");
  const group = await w.conversation(project.id, [ada.id], "Site work");
  const followed = w.raw.subscribe("artifacts");
  const list = () =>
    (w.raw.store.getState().targets.artifacts?.sections.list as
      | ArtifactRow[]
      | undefined) ?? [];
  const publish = async (title: string, versions = 1) => {
    plan.push({ title });
    await w.send(group.id, `publish ${title}`);
    await until(
      () => list().find((a) => a.title === title)?.versions.length === versions,
      20_000,
      `${title} v${versions}`,
    );
    published.set(title, list().find((a) => a.title === title)!.id);
  };
  return { w, ada, project, group, list, publish, followed };
}

const TITLE = "Artifacts";

function rowOf(r: RenderedApp, title: string): string {
  return (
    plain(r)
      .split("\n")
      .find((line) => line.includes(title))
      ?.replace(/[│┌┐└┘─]/g, "")
      .replace(/^\s*›?\s*/, "")
      .trim() ?? ""
  );
}

describe("/artifacts", () => {
  it("lists the artifacts newest first with their version, publisher and age", async () => {
    const p = await publishing();
    await p.publish("Report");
    await realDelay(20);
    await p.publish("Dashboard");
    await realDelay(20);
    await p.publish("Report", 2);
    p.followed();
    const r = await p.w.showHome();
    await enter(r, "/artifacts");
    await screenShows(r, "Dashboard");
    expect(rowOf(r, "Report")).toMatch(/^Report\s+v2\s+Ada\s+just now$/);
    expect(rowOf(r, "Dashboard")).toMatch(/^Dashboard\s+v1\s+Ada\s+just now$/);
    const screen = plain(r);
    expect(screen.indexOf("Report")).toBeLessThan(screen.indexOf("Dashboard"));
  }, 90_000);

  it("follows the list while the layer is open", async () => {
    const p = await publishing();
    p.followed();
    const r = await p.w.showHome();
    await enter(r, "/artifacts");
    await screenShows(r, "No artifacts yet");
    // The test stops following, so only the layer's own subscription brings the new one.
    await p.publish("Report").catch(() => {});
    await screenShows(r, "Report");
    expect(rowOf(r, "Report")).toMatch(/^Report\s+v1\s+Ada/);
  }, 90_000);

  it("shows the whole preview address, which the host serves, and copies it with y", async () => {
    const p = await publishing();
    await p.publish("Report");
    p.followed();
    // Wide enough for the whole address on one line, so the test reads it back in one piece.
    const r = await p.w.showHome({ columns: 240, rows: 30 });
    await enter(r, "/artifacts");
    await screenShows(r, "Report");
    await r.press(KEYS.enter);
    await screenShows(r, "Valid for an hour. Open it in a browser");
    const asked = askedStarting(p.w.wire, "artifacts.preview");
    expect(asked).toEqual([
      {
        op: "artifacts.preview",
        args: { artifactId: p.list()[0]!.id, version: 1 },
      },
    ]);
    const origin = baseUrl(p.w.host);
    const address = plain(r)
      .split("\n")
      .map((line) => line.replace(/│/g, "").trim())
      .find((line) => line.startsWith(`${origin}/preview/`));
    expect(address).toBeDefined();
    const page = await fetch(address!);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<h1>hello</h1>");

    vi.stubEnv("TMUX", "");
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((data) => {
      written.push(String(data));
      return true;
    });
    await r.press("y");
    const base64 = Buffer.from(address!, "utf8").toString("base64");
    expect(written).toContain(`\u001B]52;c;${base64}\u0007`);
    await screenShows(r, "Address copied");
  }, 90_000);

  it("adds the public address of a shared version", async () => {
    const p = await publishing();
    await p.publish("Report");
    const id = p.list()[0]!.id;
    const shared = await p.w.raw.call<{ url: string }>("artifacts", "share", {
      artifactId: id,
      version: 1,
    });
    await until(
      () => p.list()[0]?.versions[0]?.shareUrl !== null,
      10_000,
      "the share",
    );
    const shareUrl = p.list()[0]!.versions[0]!.shareUrl!;
    p.followed();
    const r = await p.w.showHome({ columns: 240, rows: 30 });
    await enter(r, "/artifacts");
    await screenShows(r, "Report");
    await r.press(KEYS.enter);
    await screenShows(r, "Public:");
    const origin = baseUrl(p.w.host);
    const full = shareUrl.startsWith("/") ? `${origin}${shareUrl}` : shareUrl;
    expect(plain(r)).toContain(`Public: ${full}`);
    expect(shared.url).toBeTruthy();
  }, 90_000);

  it("goes back to the list on Esc, and closes on a second Esc", async () => {
    const p = await publishing();
    await p.publish("Report");
    p.followed();
    const r = await p.w.showHome();
    await enter(r, "/artifacts");
    await screenShows(r, "Report");
    await r.press(KEYS.enter);
    await screenShows(r, "Valid for an hour");
    await r.press(KEYS.escape);
    await screenShows(r, (s) => !s.includes("Valid for an hour"));
    expect(plain(r)).toContain(TITLE);
    await r.press(KEYS.escape);
    await screenShows(r, (s) => !s.includes("Report"));
  }, 90_000);

  it("shows the host's refusal of a preview in the layer", async () => {
    const p = await publishing();
    await p.publish("Report");
    p.followed();
    p.w.failOn("artifacts.preview", "no such artifact");
    const r = await p.w.showHome();
    await enter(r, "/artifacts");
    await screenShows(r, "Report");
    await r.press(KEYS.enter);
    await screenShows(r, "no such artifact");
    expect(plain(r)).toContain(TITLE);
    expect(plain(r)).not.toContain("Valid for an hour");
  }, 90_000);
});
