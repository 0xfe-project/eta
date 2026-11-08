/**
 * TextPrompt on its own: a label, one input line, optional help and error lines; Enter submits a
 * value that is not blank, Esc cancels, and while busy it takes no keys.
 *
 * Rendered with the settings and the language only, for the reason given in kit-pick-list.test.tsx.
 */
import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import { TextPrompt } from "../../src/ext/kit/text-prompt";
import { renderKit } from "../ext-support/render-kit";
import { flush, KEYS, plain } from "../ui-support/render";

async function prompt(props: Partial<ComponentProps<typeof TextPrompt>> = {}) {
  const submitted: string[] = [];
  let cancelled = 0;
  const r = renderKit(
    <TextPrompt
      label="API key"
      onSubmit={(value) => submitted.push(value)}
      onCancel={() => {
        cancelled += 1;
      }}
      {...props}
    />,
  );
  await flush();
  return { r, submitted, cancelled: () => cancelled };
}

describe("text prompt", () => {
  it("does not submit an empty or blank value", async () => {
    const { r, submitted } = await prompt();
    await r.press(KEYS.enter);
    await r.type("   ");
    await r.press(KEYS.enter);
    expect(submitted).toEqual([]);
  });

  it("masks what is typed", async () => {
    const { r, submitted } = await prompt({ masked: true });
    await r.type("secret");
    expect(plain(r)).not.toContain("secret");
    expect(plain(r)).toContain("******");
    await r.press(KEYS.enter);
    expect(submitted).toEqual(["secret"]);
  });

  it("takes no keys while busy and shows the busy text", async () => {
    const { r, submitted, cancelled } = await prompt({
      busy: "Checking…",
      initialValue: "sk-1",
    });
    expect(plain(r)).toContain("Checking…");
    await r.type("x");
    await r.press(KEYS.enter);
    await r.press(KEYS.escape);
    expect(plain(r)).not.toContain("sk-1x");
    expect(submitted).toEqual([]);
    expect(cancelled()).toBe(0);
  });
});
