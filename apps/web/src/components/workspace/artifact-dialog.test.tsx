import { afterEach, describe, expect, it } from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import { artifactView, productHost } from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
import { ArtifactButton } from "./artifact-dialog";

const id = "0b7e2b1c-58f8-4a3c-9d3c-1f0e2a9b6c11";
const version = (number: number, shareUrl: string | null = null) => ({
  number,
  kind: "site",
  viewer: "iframe" as const,
  files: 3,
  bytes: 10,
  size: 10,
  createdAt: 1000 * number,
  archiveUrl: `/artifacts/${id}/${number}/archive.zip`,
  shareUrl,
  sharedAt: shareUrl === null ? null : 5000,
});
const report = (shareUrl: string | null = null) =>
  artifactView({
    id,
    title: "季度报告",
    versions: [version(2), version(1, shareUrl)],
  });

let previews = 0;
function open() {
  previews = 0;
  const host = productHost({ artifacts: [report()] });
  host.handle("artifacts.preview", (args) => {
    previews += 1;
    const { version: number } = args as { version: number };
    return {
      url: `/preview/cap${previews}-v${number}/files/index.html`,
      expiresAt: Date.now() + 3_600_000,
    };
  });
  host.handle("artifacts.share", () => ({
    artifact: report("/share/tok/"),
    url: "/share/tok/",
  }));
  host.handle("artifacts.unshare", () => ({ artifact: report() }));
  host.hello();
  return host;
}

const frame = () => document.querySelector("iframe");

afterEach(async () => {
  await cleanup();
  setWire(undefined);
});

describe("an artifact's dialog", () => {
  it("asks for a preview address of the version it opens on, and loads it sandboxed", async () => {
    const host = open();
    const { container } = await mount(
      <ArtifactButton id={id} version={1}>
        季度报告
      </ArtifactButton>,
    );
    await click(container.querySelector("button"));
    await flush();
    expect(
      host.calls.filter((c) => c.action === "preview").map((c) => c.args),
    ).toEqual([{ artifactId: id, version: 1 }]);
    // The version the tool published, not the latest; scripts but no origin.
    expect(frame()?.getAttribute("src")).toBe(
      "/preview/cap1-v1/files/index.html",
    );
    expect(frame()?.getAttribute("sandbox")).toContain("allow-scripts");
    expect(frame()?.getAttribute("sandbox")).not.toContain("allow-same-origin");
    const download = [...document.querySelectorAll("a")].find(
      (a) => a.textContent === "下载",
    );
    expect(download?.getAttribute("href")).toBe(
      `/artifacts/${id}/1/archive.zip`,
    );
  });

  it("asks again for another version, and again each time it is opened", async () => {
    const host = open();
    const { container } = await mount(
      <ArtifactButton id={id}>季度报告</ArtifactButton>,
    );
    await click(container.querySelector("button"));
    await flush();
    // The latest first.
    expect(frame()?.getAttribute("src")).toBe(
      "/preview/cap1-v2/files/index.html",
    );
    const trigger = document.querySelector<HTMLElement>('[role="combobox"]')!;
    await act(async () =>
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    // Listed latest first: the second option is version 1.
    const older = document.querySelectorAll<HTMLElement>('[role="option"]')[1];
    await act(async () =>
      older.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    await flush();
    expect(frame()?.getAttribute("src")).toBe(
      "/preview/cap2-v1/files/index.html",
    );
    // Closed and opened again: a new capability, not the one from before.
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await flush();
    expect(frame()).toBeNull();
    await click(container.querySelector("button"));
    await flush();
    expect(frame()?.getAttribute("src")).toBe(
      "/preview/cap3-v2/files/index.html",
    );
    expect(host.calls.filter((c) => c.action === "preview")).toHaveLength(3);
  });

  it("shares the shown version publicly and takes the link back", async () => {
    const host = open();
    const { container } = await mount(
      <ArtifactButton id={id} version={1}>
        季度报告
      </ArtifactButton>,
    );
    await click(container.querySelector("button"));
    await flush();
    const button = (text: string) =>
      [...document.querySelectorAll("button")].find((b) =>
        b.textContent?.includes(text),
      );
    await click(button("公开分享"));
    await flush();
    expect(host.calls.find((c) => c.action === "share")?.args).toEqual({
      artifactId: id,
      version: 1,
    });
    // The host pushes the artifact with its link; the dialog shows it.
    await act(async () =>
      host.set("artifacts", { list: [report("/share/tok/")] }),
    );
    expect(document.body.textContent).toContain("/share/tok/");
    await click(button("撤销分享"));
    await flush();
    expect(host.calls.find((c) => c.action === "unshare")?.args).toEqual({
      artifactId: id,
      version: 1,
    });
    await act(async () => host.set("artifacts", { list: [report()] }));
    expect(document.body.textContent).not.toContain("/share/tok/");
  });

  it("asks the frame to print itself, with the one message its page listens for", async () => {
    open();
    const { container } = await mount(
      <ArtifactButton id={id}>季度报告</ArtifactButton>,
    );
    await click(container.querySelector("button"));
    await flush();
    const sent: [unknown, unknown][] = [];
    frame()!.contentWindow!.postMessage = ((
      message: unknown,
      target: unknown,
    ) => sent.push([message, target])) as Window["postMessage"];
    const print = [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("导出 PDF"),
    );
    expect(print?.getAttribute("title")).toContain("另存为 PDF");
    await click(print);
    // An opaque origin has no name to address it by, hence "*"; the message carries nothing.
    expect(sent).toEqual([[{ type: "eta:print" }, "*"]]);
  });

  it("offers no print button on a touch screen", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes("pointer: coarse"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    try {
      open();
      const { container } = await mount(
        <ArtifactButton id={id}>季度报告</ArtifactButton>,
      );
      await click(container.querySelector("button"));
      await flush();
      expect(frame()).not.toBeNull();
      expect(document.body.textContent).not.toContain("导出 PDF");
    } finally {
      window.matchMedia = original;
    }
  });

  it.each([
    ["a kind this app does not know", { kind: "react" }],
    ["a kind that opens only as a download", { viewer: "download" as const }],
  ])("offers only the ZIP of %s", async (_name, fields) => {
    const host = productHost({
      artifacts: [
        artifactView({
          id,
          title: "季度报告",
          versions: [{ ...version(1), ...fields }],
        }),
      ],
    });
    host.hello();
    const { container } = await mount(
      <ArtifactButton id={id}>季度报告</ArtifactButton>,
    );
    await click(container.querySelector("button"));
    await flush();
    expect(frame()).toBeNull();
    expect(host.calls.filter((c) => c.action === "preview")).toEqual([]);
    expect(document.body.textContent).toContain("这个版本不能在这里打开");
    expect(document.body.textContent).not.toContain("新窗口");
    expect(document.body.textContent).not.toContain("导出 PDF");
    const downloads = [...document.querySelectorAll("a")].filter(
      (a) => a.getAttribute("href") === `/artifacts/${id}/1/archive.zip`,
    );
    expect(downloads.length).toBeGreaterThan(0);
  });

  it("says so when the artifact is gone", async () => {
    open();
    const { container } = await mount(
      <ArtifactButton id="missing">没了</ArtifactButton>,
    );
    await click(container.querySelector("button"));
    await flush();
    expect(frame()).toBeNull();
    expect(document.body.textContent).toContain("这个 Artifact 已不存在");
  });
});
