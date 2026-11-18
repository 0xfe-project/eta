import { createFileRoute } from "@tanstack/react-router";
import { PluginSettings } from "@/components/workspace/plugin-settings";

export const Route = createFileRoute("/_app/plugins")({
  component: PluginSettings,
});
