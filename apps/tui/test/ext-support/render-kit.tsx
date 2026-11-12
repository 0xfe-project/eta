/**
 * Renders a kit component with only what it reads from the App: the settings (for the theme) and
 * the interface language. Keys reach it as in the shell; wrap it in `InputScope` to take them away.
 */
import type { ReactElement } from "react";
import type { Locale } from "../../src/config/types";
import type { Rendered } from "../ui-support/render";
import { afterEach } from "vitest";
import { ConfigContext } from "../../src/extensions/react";
import { LocaleContext } from "../../src/i18n/react";
import { testConfig } from "../ui-support/config";
import { renderInk } from "../ui-support/render";

const mounted: Rendered[] = [];

afterEach(() => {
  for (const rendered of mounted.splice(0)) rendered.unmount();
});

/** Unmounted after the test; unmounting it sooner is fine. */
export function renderKit(
  element: ReactElement,
  options: { locale?: Locale; columns?: number; rows?: number } = {},
): Rendered {
  const locale = options.locale ?? "en";
  const rendered = renderInk(
    <ConfigContext value={testConfig({ locale })}>
      <LocaleContext value={locale}>{element}</LocaleContext>
    </ConfigContext>,
    { columns: options.columns ?? 80, rows: options.rows ?? 30 },
  );
  let unmounted = false;
  const once: Rendered = {
    ...rendered,
    unmount: () => {
      if (unmounted) return;
      unmounted = true;
      rendered.unmount();
    },
  };
  mounted.push(once);
  return once;
}
