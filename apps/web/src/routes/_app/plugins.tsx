import { createFileRoute } from "@tanstack/react-router";
import { PluginSettings } from "@/components/workspace/plugin-settings";
import { PluginsCategory } from "@/components/workspace/plugins-category";

export const Route = createFileRoute("/_app/plugins")({
  component: () => <PluginSettings category={<PluginsCategory />} />,
});
