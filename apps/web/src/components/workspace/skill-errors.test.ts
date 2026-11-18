import { expect, it } from "vitest";
import { i18n } from "@/lib/i18n";
import { skillErrorMessage } from "./skill-errors";

it("keeps raw read errors and explains moved targets and preview limits", async () => {
  await i18n.changeLanguage("zh");
  expect(skillErrorMessage(new Error("EACCES /demo"))).toBe("EACCES /demo");
  expect(skillErrorMessage(new Error("skill_files:target_moved"))).toContain(
    "路径与链接不符",
  );
  expect(skillErrorMessage(new Error("skill_files:text_limit"))).toContain(
    "预览容量上限",
  );
  await i18n.changeLanguage("en");
  try {
    expect(skillErrorMessage(new Error("skill_files:byte_limit"))).toContain(
      "preview limit",
    );
  } finally {
    await i18n.changeLanguage("zh");
  }
});
