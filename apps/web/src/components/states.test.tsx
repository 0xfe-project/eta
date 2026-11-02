import { afterEach, describe, expect, it } from "@rstest/core";
import { translate } from "@/lib/i18n";
import { cleanup, mount } from "@/test-render";
import { Loading } from "./states";

afterEach(cleanup);

const status = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[role="status"]');

describe("加载中的骨架", () => {
  it("is a status named 正在加载…, held back so a fast load never shows it", async () => {
    const { container } = await mount(<Loading />);
    expect(status(container)?.textContent).toBe(
      translate("common:states.loading"),
    );
    expect(status(container)?.classList).toContain("animate-skeleton-hold");
  });

  it("shows at once when asked to", async () => {
    const { container } = await mount(<Loading immediate />);
    expect(status(container)?.classList).not.toContain("animate-skeleton-hold");
  });

  it("draws a conversation's turns, yours on the right", async () => {
    const { container } = await mount(<Loading layout="messages" rows={4} />);
    expect(container.querySelectorAll("[data-turn]")).toHaveLength(4);
    const mine = container.querySelectorAll('[data-turn="user"]');
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0]?.classList).toContain("justify-end");
  });

  it("takes the name it is given instead of the default", async () => {
    const { container } = await mount(
      <Loading layout="messages" label={translate("chat:history.loading")} />,
    );
    expect(status(container)?.textContent).toBe(
      translate("chat:history.loading"),
    );
  });
});
