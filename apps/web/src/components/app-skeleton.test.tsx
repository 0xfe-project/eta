import { afterEach, describe, expect, it } from "@rstest/core";
import { translate } from "@/lib/i18n";
import { cleanup, mount } from "@/test-render";
import { AppSkeleton, PageSkeleton } from "./app-skeleton";

afterEach(async () => {
  await cleanup();
  document.cookie = "sidebar_state=; path=/; max-age=0";
});

describe("页面代码还在路上时的窗口轮廓", () => {
  it("is one status, named 正在加载…, and says nothing else", async () => {
    const { container } = await mount(<AppSkeleton content="chat" />);
    const statuses = container.querySelectorAll('[role="status"]');
    expect(statuses).toHaveLength(1);
    // The label is the only text: everything else is bars.
    expect(container.textContent).toBe(translate("common:states.loading"));
  });

  it("has a composer at '/' and none for the other pages", async () => {
    const chat = await mount(<AppSkeleton content="chat" />);
    expect(
      chat.container.querySelector('[data-skeleton="composer"]'),
    ).not.toBeNull();
    const page = await mount(<AppSkeleton content="page" />);
    expect(
      page.container.querySelector('[data-skeleton="composer"]'),
    ).toBeNull();
  });

  it("draws the folded rail when the sidebar was left folded", async () => {
    const open = await mount(<AppSkeleton content="chat" />);
    expect(
      open.container.querySelector('[data-rail="false"]')?.className,
    ).toContain("w-[16rem]");
    document.cookie = "sidebar_state=false; path=/";
    const folded = await mount(<AppSkeleton content="chat" />);
    expect(
      folded.container.querySelector('[data-rail="true"]')?.className,
    ).toContain("w-[4rem]");
  });

  it("gives a page under the shell one status of its own", async () => {
    const { container } = await mount(<PageSkeleton />);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.textContent).toBe(translate("common:states.loading"));
  });
});
