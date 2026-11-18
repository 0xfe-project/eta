import type { SkillSearch } from "@/components/workspace/skill-route";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { validateSkillSearch } from "@/components/workspace/skill-route";
import { SkillSettings } from "@/components/workspace/skill-settings";
import { useMachines } from "@/queries/projects";
import { useWireState } from "@/queries/wire";

export const Route = createFileRoute("/_app/plugins_/skills")({
  validateSearch: (input: Record<string, unknown>): SkillSearch => ({
    ...validateSkillSearch(input),
    // Keep an explicit key through URL normalization, even if it cannot select a device.
    device:
      input.device === undefined
        ? undefined
        : typeof input.device === "string" ||
            typeof input.device === "number" ||
            typeof input.device === "boolean"
          ? String(input.device)
          : "",
  }),
  component: function SkillDirectoryRoute() {
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    const router = useRouter();
    const { machines, loaded, error } = useMachines();
    const connected = useWireState((state) => state.status === "open");
    const primaryId =
      connected && loaded && !error
        ? machines.find(
            ({ kind, status }) => kind === "primary" && status === "online",
          )?.id
        : undefined;

    useEffect(() => {
      if (!primaryId || search.device !== undefined) return;
      // Check the live address, not just this render: a manual choice or a
      // move to detail may have happened already. Even an empty device key is explicit.
      const current = router.history.location;
      if (
        current.pathname.replace(/\/$/, "") !== "/plugins/skills" ||
        new URLSearchParams(current.search).has("device")
      )
        return;
      void navigate({
        search: (previous) => ({
          ...previous,
          device: previous.device ?? primaryId,
        }),
        hash: true,
        replace: true,
        resetScroll: false,
      });
    }, [navigate, primaryId, router, search.device]);
    return (
      <SkillSettings
        search={search}
        onSearch={(search) =>
          void navigate({
            search: (previous) => ({ ...previous, ...search }),
            replace: true,
            resetScroll: false,
          })
        }
      />
    );
  },
});
