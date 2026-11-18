import type { SkillFileContent, SkillTarget } from "@eta/client-contracts";
import { SKILL_FILE_LIMITS } from "@eta/client-contracts";
import { act } from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { setWire } from "@/lib/wire";
import { closeBrowser, hasBrowser, onPage, PHONE } from "@/test-browser";
import { buildProductHost } from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
import { SkillBody } from "./skill-reader";
import { skillLink, SkillResources } from "./skill-resources";

const TARGET: SkillTarget = {
  machineId: "device",
  home: "/home/me",
  scope: "personal",
  epoch: 4,
};
const text = (value: string): Extract<SkillFileContent, { kind: "text" }> => ({
  kind: "text",
  text: value,
  version: "v1",
  size: value.length,
  diagnostics: [],
});
const pixel: Extract<SkillFileContent, { kind: "image" }> = {
  kind: "image",
  base64:
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFeQAAAAASUVORK5CYII=",
  size: 68,
  width: 1,
  height: 1,
  mime: "image/png",
};
function host() {
  const fake = buildProductHost({}, ["skills"]);
  fake.handle("skills.read", () => ({ target: TARGET, result: pixel }));
  fake.handle("skills.close", () => ({ target: TARGET, result: {} }));
  fake.install();
  fake.hello();
  return fake;
}
afterEach(async () => {
  await cleanup();
  setWire(undefined);
  vi.restoreAllMocks();
});

afterAll(closeBrowser);

const browserAvailable = await hasBrowser();
describe("skill resource boundary", () => {
  it.each([
    "../../other/a.md",
    "/etc/passwd",
    "//host/a.png",
    "file:///tmp/a",
    "javascript:alert(1)",
    "data:image/png;base64,a",
    "blob:external",
    "%2fetc/passwd",
    "%5cetc",
    "%2e%2e/%2e%2e/out",
    "C:/file",
    "a%00b",
    "a?raw",
  ])("rejects %s", (raw) => {
    expect(skillLink("docs/a.md", raw)).toEqual({ kind: "blocked" });
  });
  it("normalizes inside relative paths and anchors only, retains safe external URLs", () => {
    expect(skillLink("docs/a.md", "../assets/icon.png")).toEqual({
      kind: "file",
      path: "assets/icon.png",
      anchor: "",
    });
    expect(skillLink("docs/a.md", "#part")).toEqual({
      kind: "file",
      path: "docs/a.md",
      anchor: "part",
    });
    expect(skillLink("SKILL.md", "https://example.com/read")).toEqual({
      kind: "external",
      url: "https://example.com/read",
    });
  });
  it("never installs external image URLs; each click remains restricted with zero fetch", async () => {
    const fake = host();
    const fetch = vi.spyOn(globalThis, "fetch");
    const resources = new SkillResources(TARGET, "detail");
    await mount(
      <SkillBody
        content={text(
          "![first](https://example.com/a.png)\n\n![second](https://example.com/b.png)\n\n[web](https://example.com/page)\n\n![bad](data:image/png;base64,AAAA)",
        )}
        path="SKILL.md"
        resources={resources}
        reachable
        navigate={() => {}}
      />,
    );
    await flush(100);
    expect(document.querySelector('img[src^="http"]')).toBeNull();
    expect(document.querySelector("[srcset],iframe,svg")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    const actions = [...document.querySelectorAll("button")].filter(
      (node) => node.textContent === "加载外部图片",
    );
    expect(actions).toHaveLength(2);
    await click(actions[0]);
    expect(document.body.textContent).toContain("未发送请求");
    expect(document.querySelectorAll("[role=status]")).toHaveLength(2);
    expect(fake.calls.filter((call) => call.action === "read")).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
    const a = document.querySelector("a")!;
    expect(a.target).toBe("_blank");
    expect(a.rel).toBe("noopener noreferrer");
  });
  it("local images use only the scoped API and generated object URLs; releases once", async () => {
    const fake = host();
    const create = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:controlled");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const resources = new SkillResources(TARGET, "detail");
    await mount(
      <SkillBody
        content={text("![one](assets/p.png)\n\n![again](assets/p.png)")}
        path="SKILL.md"
        resources={resources}
        reachable
        navigate={() => {}}
      />,
    );
    await flush(100);
    expect(fake.calls.filter((call) => call.action === "read")).toHaveLength(1);
    expect(fake.calls[0]?.args).toEqual({
      target: TARGET,
      input: { detail: "detail", path: "assets/p.png" },
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("img")).toHaveLength(2);
    expect(document.querySelector("img")?.getAttribute("src")).toBe(
      "blob:controlled",
    );
    await act(async () =>
      document.querySelector("img")!.dispatchEvent(new Event("error")),
    );
    expect(document.body.textContent).toContain("图片解码失败");
    await resources.dispose();
    expect(revoke).toHaveBeenCalledWith("blob:controlled");
  });
  it("image size/pixels/aggregate <= boundary; no object URL is created over budget", () => {
    host();
    const create = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:controlled");
    const r = new SkillResources(TARGET, "detail");
    const full = {
      ...pixel,
      base64: btoa("a".repeat(SKILL_FILE_LIMITS.imageBytes)),
      size: SKILL_FILE_LIMITS.imageBytes,
      width: 5000,
      height: 4000,
    };
    expect(r.image("full", full)).toBe("blob:controlled");
    expect(r.image("full", full)).toBe("blob:controlled");
    expect(create).toHaveBeenCalledTimes(1);
    expect(() => r.image("next", pixel)).toThrow("image_limit");
    expect(() =>
      new SkillResources(TARGET, "d2").image("huge", {
        ...pixel,
        width: 5001,
        height: 4000,
      }),
    ).toThrow("image_limit");
    expect(() =>
      new SkillResources(TARGET, "d3").image("huge", {
        ...pixel,
        size: SKILL_FILE_LIMITS.imageBytes + 1,
      }),
    ).toThrow("image_limit");
  });
  it("HTML and SVG are escaped source, unsupported files show size, no active elements", async () => {
    host();
    const resources = new SkillResources(TARGET, "detail");
    const source =
      '<script>window.bad=true</script><img src="https://example.com/leak"><svg onload="alert(1)"></svg>';
    const shown = await mount(
      <SkillBody
        content={text(source)}
        path="page.html"
        resources={resources}
        reachable
        navigate={() => {}}
      />,
    );
    expect(document.querySelector("pre")?.textContent).toBe(source);
    expect(document.querySelector("script,img,svg")).toBeNull();
    await shown.show(
      <SkillBody
        content={text(source)}
        path="picture.svg"
        resources={resources}
        reachable
        navigate={() => {}}
      />,
    );
    expect(document.querySelector("pre")?.textContent).toBe(source);
    expect(document.querySelector("svg")).toBeNull();
    await shown.show(
      <SkillBody
        content={{ kind: "unsupported", size: 123, reason: "binary" }}
        path="blob.bin"
        resources={resources}
        reachable
        navigate={() => {}}
      />,
    );
    expect(document.body.textContent).toContain("123");
    expect(document.body.textContent).toContain("不支持预览");
  });
  it("relative file and anchor clicks use in-skill navigation, blocked links have no href", async () => {
    host();
    const resources = new SkillResources(TARGET, "detail");
    const navigate = vi.fn();
    await mount(
      <SkillBody
        content={text(
          "[file](docs/a.md#part) [anchor](#heading) [escape](../outside.md)",
        )}
        path="SKILL.md"
        resources={resources}
        reachable
        navigate={navigate}
      />,
    );
    await flush(100);
    await click(document.querySelector("a"));
    expect(navigate).toHaveBeenCalledWith("docs/a.md", "part");
    await click(document.querySelectorAll("a")[1]);
    expect(navigate).toHaveBeenCalledWith("SKILL.md", "heading");
    expect(document.querySelectorAll("a")).toHaveLength(2);
  });
  it("late file reads after detail close cannot retain new resources", async () => {
    const fake = host();
    let resolve!: (value: unknown) => void;
    fake.handle(
      "skills.read",
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const resources = new SkillResources(TARGET, "detail");
    const read = resources.read("a.png");
    const outcome = read.catch((error) => error.message);
    await flush();
    await resources.dispose();
    resolve({ target: TARGET, result: pixel });
    expect(await outcome).toContain("detail_expired");
  });
  it.skipIf(!browserAvailable)(
    "real browser: initial external-image markup emits zero requests, layout scrolls independently and collapses at phone width",
    async () => {
      host();
      const resources = new SkillResources(TARGET, "detail");
      await mount(
        <div className="flex h-80 min-h-0 flex-col" data-skill-detail>
          <div className="flex min-h-0 flex-1 overflow-hidden border">
            <nav
              aria-label="技能目录"
              className="hidden w-40 shrink-0 overflow-auto border-r sm:block"
            >
              <div style={{ height: 1200 }}>files</div>
            </nav>
            <div data-body className="min-w-0 flex-1 overflow-auto">
              <SkillBody
                content={text(
                  `![off](https://example.com/never.png)\n\n[web](https://example.com/page)\n\n${"paragraph\n\n".repeat(300)}`,
                )}
                path="SKILL.md"
                resources={resources}
                reachable
                navigate={() => {}}
              />
            </div>
          </div>
        </div>,
      );
      await flush(100);
      const markup = document.body.innerHTML;
      await onPage(markup, async (page) => {
        const external: string[] = [];
        page.on("request", (request) => {
          if (request.url().startsWith("http")) external.push(request.url());
        });
        // Install listeners BEFORE parsing the rendered resource markup again.
        await page.evaluate((markup) => {
          document.body.innerHTML = markup;
        }, markup);
        await page.waitForTimeout(100);
        expect(await page.locator("img").count()).toBe(0);
        expect(external).toEqual([]);
        const sizes = await page.locator("[data-body]").evaluate((element) => ({
          client: element.clientHeight,
          scroll: element.scrollHeight,
          overflow: getComputedStyle(element).overflowY,
        }));
        expect(sizes.overflow).toBe("auto");
        expect(sizes.scroll).toBeGreaterThan(sizes.client);
        expect(await page.locator("nav").isVisible()).toBe(true);
      });
      await onPage(
        markup,
        async (page) => {
          expect(await page.locator("nav").isVisible()).toBe(false);
          expect(await page.locator("[data-body]").isVisible()).toBe(true);
        },
        PHONE,
      );
    },
  );
});

it("renders parsed metadata separately, never as a Markdown heading, retaining unknown fields", async () => {
  host();
  const raw =
    "---\nname: demo\ndescription: useful\nx-unknown: [1, 2]\n---\n# Instructions";
  await mount(
    <SkillBody
      content={{
        ...text(raw),
        preview: {
          body: "# Instructions",
          metadata: "name: demo\ndescription: useful\nx-unknown: [1, 2]",
        },
      }}
      path="SKILL.md"
      resources={new SkillResources(TARGET, "detail")}
      reachable
      navigate={() => {}}
    />,
  );
  await flush(100);
  expect(document.querySelector("details")?.textContent).toContain(
    "x-unknown: [1, 2]",
  );
  expect(document.querySelector(".markdown")?.textContent).toBe("Instructions");
  expect(document.querySelector("h2")).toBeNull();
});
it.each([
  "---\n[broken yaml\n---\n# body",
  "---\ndescription: unterminated\n# body",
])("keeps malformed frontmatter readable as source: %s", async (raw) => {
  host();
  await mount(
    <SkillBody
      content={text(raw)}
      path="SKILL.md"
      resources={new SkillResources(TARGET, "detail")}
      reachable
      navigate={() => {}}
    />,
  );
  expect(document.querySelector("pre")?.textContent).toBe(raw);
  expect(document.querySelector(".markdown")).toBeNull();
});
