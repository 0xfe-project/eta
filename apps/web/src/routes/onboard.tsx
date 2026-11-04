import { createFileRoute } from "@tanstack/react-router";
import { Loading } from "@/components/states";
import { Onboard } from "@/pages/onboard";

export const Route = createFileRoute("/onboard")({
  component: Onboard,
  pendingComponent: () => (
    <Loading
      layout="detail"
      immediate
      className="mx-auto w-full max-w-2xl p-4"
    />
  ),
});
