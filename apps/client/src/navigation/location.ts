import type { Page } from "./routes";
import { platform, UrlScheme } from "nsh";
const pages: Page[] = [
  "chat",
  "tasks",
  "routines",
  "plugins",
  "settings",
  "captain",
  "pending",
  "more",
  "onboard",
];

export function workspaceLocation() {
  const current = UrlScheme.url();
  if (!current || platform.os !== "web")
    return { page: "chat" as Page, conversation: "" };
  const url = new URL(current);
  const path = url.pathname.split("/").filter(Boolean)[0];
  return {
    page:
      url.searchParams.get("settings") === "update"
        ? ("settings" as Page)
        : (pages.find((page) => page === path) ?? "chat"),
    update: url.searchParams.get("settings") === "update",
    conversation: url.searchParams.get("conversation") ?? "",
  };
}

export function link(nextPage: Page, id?: string) {
  const current = UrlScheme.url();
  if (!current || platform.os !== "web") return;
  const url = new URL(current);
  url.pathname = nextPage === "chat" ? "/" : `/${nextPage}`;
  if (id) url.searchParams.set("conversation", id);
  else url.searchParams.delete("conversation");
  if (url.href !== current) UrlScheme.setUrl(url.href, { history: "push" });
}
