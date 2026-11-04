import { describe, expect, it } from "@rstest/core";
import { PageSkeleton } from "@/components/app-skeleton";
import { getRouter } from "./router";

describe("路由的滚动恢复", () => {
  const restores = (pathname: string) => {
    const { scrollRestoration } = getRouter().options;
    return typeof scrollRestoration === "function"
      ? scrollRestoration({ location: { pathname } as never })
      : scrollRestoration;
  };

  it("leaves the chat alone: its scrollers belong to the conversation on show", () => {
    expect(restores("/")).toBe(false);
  });

  it("still restores the other pages", () => {
    expect(restores("/settings")).toBe(true);
    expect(restores("/tasks")).toBe(true);
  });
});

describe("页面代码下载时的占位", () => {
  it("shows the page's outline after 200ms, and keeps it 300ms once shown", () => {
    const { options } = getRouter();
    expect(options.defaultPendingComponent).toBe(PageSkeleton);
    expect(options.defaultPendingMs).toBe(200);
    expect(options.defaultPendingMinMs).toBe(300);
  });

  it("gives the two routes with their own shell a whole-window outline", () => {
    const { routesById } = getRouter();
    expect(routesById["/"].options.pendingComponent).toBeDefined();
    expect(routesById["/_app"].options.pendingComponent).toBeDefined();
  });
});
