/** An agent to start from: a role card's name, what it owns, and the instructions it gives. */
export interface AgentTemplate {
  id: string;
  name: string;
  /** What the card says after the name, such as "one per account". */
  note?: string;
  category: string;
  summary: string;
  owns: string[];
  doesNotOwn: string[];
  needsApproval: string[];
  /** The instructions, with `{PLACEHOLDERS}` to fill. */
  instructions: string;
}

/** The categories the cards use, in the order the gallery lists them, and their Chinese names. */
export const templateCategories: Record<string, string> = {
  Engineering: "工程",
  "Product & design": "产品与设计",
  "Sales & sales engineering": "销售",
  "Marketing & growth": "市场与增长",
  "Customer support": "客户支持",
  "Post-sales & personal ops": "售后与个人事务",
  "Operations, events & finance": "运营、活动与财务",
  Orchestration: "协作编排",
};

const placeholder = /\{([^{}\n]+)\}/g;

/** The placeholders in `text` besides `{NAME}`, which is the agent's name, in first-use order. */
export function placeholdersOf(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(placeholder))
    if (match[1] !== "NAME") seen.add(match[1]!);
  return [...seen];
}

/** `text` with `{NAME}` as `name` and each placeholder given a value; the rest stay as written. */
export function fillTemplate(
  text: string,
  name: string,
  values: Record<string, string>,
): string {
  return text.replace(placeholder, (whole, key: string) => {
    if (key === "NAME") return name.trim() || whole;
    return values[key]?.trim() || whole;
  });
}

/** The templates that match `query` (name, summary, category) in `category`, if one is chosen. */
export function findTemplates(
  list: readonly AgentTemplate[],
  query: string,
  category?: string,
): AgentTemplate[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((template) => {
    if (category && template.category !== category) return false;
    const haystack = [
      template.name,
      template.summary,
      template.category,
      templateCategories[template.category] ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
