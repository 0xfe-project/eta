import type { JSX } from "nsh";
import { createNavStack } from "nsh/base";

/** A pushed page: its key and what makes it. Features push through `nav/links.tsx`. */
export interface Route {
  key: string;
  page: () => JSX.Element;
}

/** The first route is the tabs; `Root` renders it. */
export const nav = createNavStack<Route>([{ key: "tabs", page: () => null as never }]);

/** Push a page, unless the same page is on top already. */
export function open(key: string, page: () => JSX.Element): void {
  const routes = nav.routes();
  if (routes[routes.length - 1]?.key === key) return;
  nav.push({ key, page });
}
