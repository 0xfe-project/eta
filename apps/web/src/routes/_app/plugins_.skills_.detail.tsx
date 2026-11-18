import { createFileRoute } from "@tanstack/react-router";
import {
  validateSkillDetailSearch,
  validateSkillSearch,
} from "@/components/workspace/skill-route";
import { SkillDetailPage } from "@/components/workspace/skill-settings";

export const Route = createFileRoute("/_app/plugins_/skills_/detail")({
  validateSearch: validateSkillDetailSearch,
  component: function SkillDetailRoute() {
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    return (
      <SkillDetailPage
        search={search}
        onBack={() =>
          void navigate({
            to: "/plugins/skills",
            search: validateSkillSearch({ ...search }),
            replace: true,
          })
        }
      />
    );
  },
});
