import { afterEach, describe, expect, it } from "@rstest/core";
import { cleanup, click, mount } from "@/test-render";
import { DesktopTooOld } from "./desktop-too-old";

function shell(appVersion: string | undefined) {
  const global = globalThis as { __ETA_HOST__?: unknown };
  global.__ETA_HOST__ = { native: true, appVersion };
}

afterEach(async () => {
  await cleanup();
  delete (globalThis as { __ETA_HOST__?: unknown }).__ETA_HOST__;
});

describe("an app older than its host allows", () => {
  it("is told to update", async () => {
    shell("0.1.0");
    const { container } = await mount(<DesktopTooOld min="0.2.0" />);
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("0.2.0");
    expect(alert?.textContent).toContain("0.1.0");
  });

  it("can be put away", async () => {
    shell("0.1.0");
    const { container } = await mount(<DesktopTooOld min="0.2.0" />);
    await click(container.querySelector('[role="alert"] button'));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it.each([
    ["an app new enough", "0.2.0"],
    ["a dev build", "dev"],
  ])("is not %s", async (_name, version) => {
    shell(version);
    const { container } = await mount(<DesktopTooOld min="0.2.0" />);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("is not a browser", async () => {
    const { container } = await mount(<DesktopTooOld min="99.0.0" />);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
