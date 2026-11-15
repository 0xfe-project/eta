import { afterEach, describe, expect, it } from "@rstest/core";
import { translate } from "@/lib/i18n";
import { cleanup, mount } from "@/test-render";
import { AppSkeleton, PageSkeleton } from "./app-skeleton";

afterEach(async () => {
  await cleanup();
  document.cookie = "sidebar_state=; path=/; max-age=0";
  localStorage.clear();
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
    const rail = (container: HTMLElement) =>
      container.querySelector("[data-rail]")?.getAttribute("data-rail");
    const open = await mount(<AppSkeleton content="chat" />);
    expect(rail(open.container)).toBe("false");
    document.cookie = "sidebar_state=false; path=/";
    const folded = await mount(<AppSkeleton content="chat" />);
    expect(rail(folded.container)).toBe("true");
  });

  it("draws the sidebar at its dragged width, and the rail stays the rail", async () => {
    const side = (container: HTMLElement) =>
      container.querySelector<HTMLElement>("[data-rail]")!;
    const fresh = await mount(<AppSkeleton content="chat" />);
    expect(side(fresh.container).style.width).toBe("");

    localStorage.setItem("eta.sidebar.width", "340");
    const dragged = await mount(<AppSkeleton content="chat" />);
    expect(side(dragged.container).style.width).toBe("340px");

    localStorage.setItem("eta.sidebar.width", "9000");
    const clamped = await mount(<AppSkeleton content="page" />);
    expect(side(clamped.container).style.width).toBe("420px");

    document.cookie = "sidebar_state=false; path=/";
    const folded = await mount(<AppSkeleton content="chat" />);
    expect(side(folded.container).style.width).toBe("");
  });

  it("gives a page under the shell one status of its own", async () => {
    const { container } = await mount(<PageSkeleton />);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.textContent).toBe(translate("common:states.loading"));
  });
});
