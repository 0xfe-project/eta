import type { SkillDetailSearch } from "./skill-route";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { buttonVariants } from "@/components/ui/button";
import { validateSkillSearch } from "./skill-route";

export function PluginsCategory({
  skills,
  search,
}: {
  skills?: boolean;
  search?: SkillDetailSearch;
}) {
  const { t } = useTranslation(["plugins", "skills"] as const);
  return (
    <nav
      aria-label={t("categories")}
      className="flex w-fit gap-1 border-b pb-1"
    >
      <Link
        to="/plugins"
        aria-current={skills ? false : "page"}
        className={buttonVariants({
          size: "sm",
          variant: skills ? "ghost" : "secondary",
        })}
      >
        {t("title")}
      </Link>
      <Link
        to="/plugins/skills"
        search={validateSkillSearch({ ...search })}
        aria-current={skills ? "page" : false}
        className={buttonVariants({
          size: "sm",
          variant: skills ? "secondary" : "ghost",
        })}
      >
        {t("skills:title")}
      </Link>
    </nav>
  );
}
