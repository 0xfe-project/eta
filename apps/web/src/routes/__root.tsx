import type { RouterContext } from "@/lib/query-client";
import { createRootRouteWithContext } from "@tanstack/react-router";
import { RootDocument } from "@/pages/root-document";

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootDocument,
});
