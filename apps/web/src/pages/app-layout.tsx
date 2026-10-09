import { Outlet } from "@tanstack/react-router";
import { AppShell } from "@/components/workspace/app-shell";

export function AppLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
