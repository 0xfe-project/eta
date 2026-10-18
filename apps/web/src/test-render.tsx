// Rendering for component tests: a root under a QueryClient, and one call to take everything down.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom has none of these.
const globals = globalThis as Record<string, unknown>;
globals.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
};
globals.IntersectionObserver ??= class {
  observe() {}
  disconnect() {}
};

const disposers: (() => void)[] = [];

/** Render `node`; the returned `show` renders another node into the same root. */
export async function mount(node: React.ReactNode, client?: QueryClient) {
  const queryClient =
    client ??
    new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const show = (next: React.ReactNode) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>{next}</QueryClientProvider>,
      ),
    );
  await show(node);
  disposers.push(() => {
    root.unmount();
    container.remove();
  });
  return { container, show, queryClient };
}

/** Unmount everything `mount` rendered. */
export async function cleanup() {
  await act(async () => disposers.splice(0).forEach((dispose) => dispose()));
}

/** Let promises and timers settle: replies from the fake host, state pushes. */
export async function flush(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** The first button whose text contains `text`. */
export const button = (root: ParentNode, text: string) =>
  [...root.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(text),
  );

/** Click an element the way a user does, inside act. */
export async function click(element: Element | null | undefined) {
  if (!element) throw new Error("nothing to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}
