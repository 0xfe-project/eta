import { afterEach, describe, expect, it } from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import { interactionView, surfaceHost } from "@/test-inbox";
import { cleanup, flush, mount } from "@/test-render";
import { LiveChat } from "./live-chat";

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  document.title = "";
});

describe("the tab's title", () => {
  it("counts the questions waiting for the user, wherever they were asked", async () => {
    const host = surfaceHost();
    await mount(<LiveChat />);
    await flush();
    expect(document.title).toBe("eta");
    await act(async () =>
      host.set("inbox", {
        list: [
          interactionView({ id: "i1" }),
          interactionView({ id: "i2", conversationId: null }),
          interactionView({ id: "i3", status: "answered" }),
        ],
      }),
    );
    await flush();
    expect(document.title).toBe("(2) eta");
  });
});
