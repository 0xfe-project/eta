import { afterEach, describe, expect, it } from "@rstest/core";
import { setWire } from "@/lib/wire";
import { cleanup, mount } from "@/test-render";
import { EmailMessageHtml } from "./email-message-html";

afterEach(async () => {
  await cleanup();
  setWire(undefined);
});

describe("email message HTML", () => {
  it("renders the original mail frame with local CID assets", async () => {
    const view = await mount(
      <EmailMessageHtml
        title="ETA mail"
        text="Fallback"
        html={`<html><head></head><body><img src="cid:eta-logo@eta"><img src="cid:eta-data@demo"></body></html>`}
      />,
    );
    const frame = view.container.querySelector("iframe");
    expect(frame?.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(frame?.getAttribute("sandbox")).not.toContain("allow-scripts");
    expect(frame?.getAttribute("srcdoc")).toContain("Content-Security-Policy");
    expect(frame?.getAttribute("srcdoc")).toContain(
      "html,body{overflow:hidden!important;max-width:100%!important}",
    );
    expect(frame?.getAttribute("srcdoc")).toContain(
      "img{max-width:100%!important;height:auto!important}",
    );
    expect(frame?.getAttribute("scrolling")).toBe("no");
    expect(frame?.getAttribute("srcdoc")).toContain("/Eta-Logo.png");
    expect(frame?.getAttribute("srcdoc")).toContain("data:image/png;base64,");
  });

  it("falls back to the text body when a message has no HTML", async () => {
    const view = await mount(
      <EmailMessageHtml title="Plain mail" html="" text="# Plain" />,
    );
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(view.container.textContent).toContain("Plain");
  });
});
