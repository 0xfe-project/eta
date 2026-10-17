import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ProviderEditor } from "./provider-editor";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanup: (() => void)[] = [];
const bodies: unknown[] = [];

async function render(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>{node}</QueryClientProvider>,
    ),
  );
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  return container;
}

afterEach(async () => {
  await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
  bodies.length = 0;
  rstest.restoreAllMocks();
});

const provider = {
  id: "local",
  name: "Local",
  kind: "openai-compatible",
  baseUrl: "http://127.0.0.1:1/v1",
  has_key: true,
  headers: { "x-test": "1" },
  models: [
    {
      id: "m1",
      name: "One",
      context_window: 8000,
      input: ["text"],
      reasoning: true,
      thinking_mode: "both",
      levels: ["low", "high"],
    },
  ],
};

async function save(container: ParentNode) {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "保存",
  )!;
  await act(async () => button.click());
}

describe("provider 编辑表单", () => {
  it("提交时不带 key，等于「别动它」", async () => {
    rstest
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        if (init?.body !== undefined)
          bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ restart_required: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
    const container = await render(
      <ProviderEditor provider={provider} open onOpenChange={() => {}} />,
    );
    await save(document);
    const body = bodies[0] as Record<string, unknown>;
    expect("apiKey" in body).toBe(false);
    expect(body.baseUrl).toBe("http://127.0.0.1:1/v1");
    expect(body.headers).toEqual({ "x-test": "1" });
    // Saving says it takes a restart, because it does.
    expect(container.ownerDocument.body.textContent).toContain("重启");
  });

  it("清除 key 时提交 null", async () => {
    rstest
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        if (init?.body !== undefined)
          bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ restart_required: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
    await render(
      <ProviderEditor provider={provider} open onOpenChange={() => {}} />,
    );
    const clear = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("清除 key"),
    )!;
    await act(async () => clear.click());
    await save(document);
    expect((bodies[0] as { apiKey?: unknown }).apiKey).toBeNull();
  });
});

describe("改了一半就走", () => {
  it("先问，不直接丢掉", async () => {
    const closed: boolean[] = [];
    await render(
      <ProviderEditor
        provider={provider}
        open
        onOpenChange={(open) => closed.push(open)}
      />,
    );
    const name = document.querySelector<HTMLInputElement>("#provider-name")!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setter?.call(name, "改了个名字");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // The dialog's own close path: Escape / the X both land here.
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => {
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    const alert = document.querySelector('[role="alertdialog"]');
    expect(alert?.textContent).toContain("还没保存");
    expect(closed).toEqual([]);

    const discard = [...alert!.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("放弃"),
    )!;
    await act(async () => discard.click());
    expect(closed).toEqual([false]);
  });
});
