import type { Plugin } from "react-grab";
import { storageKey } from "@/components/workspace/workspace-store";

// 圈选元素: React Grab, to pick an element and copy its components and source
// locations. Production builds stay React's production build; locations come
// from the client's public source maps (vite.config.ts) and the DevTools hook
// installed at startup (react-devtools-hook.ts).

/** Unset: on in development, off in production. */
export function elementPickerDefault() {
  return import.meta.env.DEV;
}

/**
 * The saved choice, read straight from storage at startup: the workspace
 * store is rehydrated later, and the picker is best installed before
 * React's first commit.
 */
export function savedElementPicker() {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "");
    if (
      typeof saved === "object" &&
      saved !== null &&
      "reactGrab" in saved &&
      typeof saved.reactGrab === "boolean"
    ) {
      return saved.reactGrab;
    }
  } catch {
    // Nothing saved, or storage unavailable.
  }
  return elementPickerDefault();
}

/** Loads React Grab on first use; afterwards only turns it on or off. */
export async function setElementPicker(enabled: boolean) {
  const api = window.__REACT_GRAB__;
  if (api) {
    api.setEnabled(enabled);
  } else if (enabled) {
    const { getStack, registerPlugin } = await import("react-grab");
    registerPlugin(lineNumbers(getStack));
  }
}

/**
 * React Grab prints line numbers only for Next.js apps; its stack has them,
 * so `in Button (at …/button.tsx)` becomes `(at …/button.tsx:43)`.
 */
function lineNumbers(getStack: typeof import("react-grab").getStack): Plugin {
  return {
    name: "axp-line-numbers",
    hooks: {
      transformCopyContent: async (content, elements) => {
        const frames = (await Promise.all(elements.map(getStack))).flat();
        return content.replace(
          /in (\S+) \(at ([^)]+)\)/g,
          (match, name: string, path: string) => {
            const frame = frames.find(
              (f) =>
                f?.functionName === name &&
                f.lineNumber &&
                f.fileName?.endsWith(path),
            );
            return frame
              ? `in ${name} (at ${path}:${frame.lineNumber})`
              : match;
          },
        );
      },
    },
  };
}
