import { createFileRoute } from "@tanstack/react-router";
import { validateSettingsSearch } from "@/components/workspace/settings-route";
import { SettingsPage } from "@/pages/settings";

export const Route = createFileRoute("/_app/settings")({
  validateSearch: validateSettingsSearch,
  component: SettingsPage,
});
