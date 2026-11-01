import { Outlet } from "@tanstack/react-router";
import { AppShell } from "@/components/workspace/app-shell";
import { useEtaMailNotifications } from "@/components/workspace/email-notifications";
import { useOnboardRedirect } from "@/lib/onboard";

export function AppLayout() {
  useOnboardRedirect();
  useEtaMailNotifications();
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
