import { Outlet } from "@tanstack/react-router";
import { AppShell } from "@/components/workspace/app-shell";
import { useOnboardRedirect } from "@/lib/onboard";

export function AppLayout() {
  useOnboardRedirect();
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
