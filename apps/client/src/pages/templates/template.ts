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
  /** Optional plugin names or integration slugs this role typically pairs with. */
  recommendedPlugins?: string[];
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

type Segment =
  | { kind: "text"; text: string }
  | { kind: "brace"; raw: string; children: Segment[] };

const optionalClausePrefix = /^(?:OPTIONAL|[A-Z][A-Z0-9 /_-]*VARIANT):\s*/;
const exampleClausePrefix = /^(?:e\.g\.|for example)[:,]?\s*/i;

/** Parse balanced `{...}` spans on a single line into a shallow/nested AST; unmatched braces stay text. */
function parseSegments(text: string): Segment[] {
  const out: Segment[] = [];
  let plain = "";
  const flush = () => {
    if (plain) {
      out.push({ kind: "text", text: plain });
      plain = "";
    }
  };
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{") {
      plain += text[i]!;
      i++;
      continue;
    }
    let depth = 1;
    let j = i + 1;
    while (j < text.length && text[j] !== "\n" && depth > 0) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") depth--;
      if (depth > 0) j++;
    }
    if (depth === 0 && j > i + 1) {
      flush();
      const raw = text.slice(i + 1, j);
      out.push({ kind: "brace", raw, children: parseSegments(raw) });
      i = j + 1;
    } else {
      plain += text[i]!;
      i++;
    }
  }
  flush();
  return out;
}

function hasNestedBrace(segments: readonly Segment[]): boolean {
  return segments.some((segment) => segment.kind === "brace");
}

function collectLeafKeys(segments: readonly Segment[], seen: Set<string>) {
  for (const segment of segments) {
    if (segment.kind !== "brace") continue;
    if (hasNestedBrace(segment.children)) {
      collectLeafKeys(segment.children, seen);
    } else if (segment.raw !== "NAME") {
      seen.add(segment.raw);
    }
  }
}

/** The leaf placeholders in `text` besides `{NAME}`, which is the agent's name, in first-use order. */
export function placeholdersOf(text: string): string[] {
  const seen = new Set<string>();
  collectLeafKeys(parseSegments(text), seen);
  return [...seen];
}

function renderSegments(
  segments: readonly Segment[],
  name: string,
  values: Record<string, string>,
): { text: string; filled: boolean } {
  let out = "";
  let anyFilled = false;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (segment.kind === "text") {
      out += segment.text;
      continue;
    }
    if (!hasNestedBrace(segment.children)) {
      if (segment.raw === "NAME") {
        const value = name.trim();
        if (value) {
          out += value;
          anyFilled = true;
        } else {
          out += `{${segment.raw}}`;
        }
      } else {
        const value = values[segment.raw]?.trim();
        if (value) {
          out += value;
          anyFilled = true;
        } else {
          out += `{${segment.raw}}`;
        }
      }
      continue;
    }
    const direct = values[segment.raw]?.trim();
    if (direct) {
      out += direct;
      anyFilled = true;
      continue;
    }
    const inner = renderSegments(segment.children, name, values);
    if (optionalClausePrefix.test(segment.raw)) {
      if (inner.filled) {
        out += inner.text.replace(optionalClausePrefix, "");
        anyFilled = true;
      } else {
        // Drop the unfilled optional/variant clause and tidy the splice point.
        const next = segments[i + 1];
        const nextText = next?.kind === "text" ? next.text : "";
        if (/^[.!?;]/.test(nextText)) {
          out = out.replace(/[,;]?[ \t]+$/, "");
        } else if (!nextText || /^[ \t\n]/.test(nextText)) {
          out = out.replace(/[ \t]+$/, "");
        }
      }
      continue;
    }
    if (inner.filled) {
      out += inner.text.replace(exampleClausePrefix, "");
      anyFilled = true;
    } else {
      out += inner.text;
    }
  }
  return { text: out, filled: anyFilled };
}

/**
 * `text` with `{NAME}` as `name` and each leaf placeholder given a value.
 * Nested `{OPTIONAL: ... {KEY} ...}` / `{... VARIANT: ... {KEY} ...}` clauses unwrap when filled
 * and drop cleanly when omitted; other nested `{...}` clauses unwrap their outer braces cleanly.
 */
export function fillTemplate(
  text: string,
  name: string,
  values: Record<string, string>,
): string {
  return renderSegments(parseSegments(text), name, values).text;
}

const integrationPatterns: readonly [string, RegExp][] = [
  ["slack", /\bslack\b/i],
  ["gmail", /\bgmail\b|\bemail\b|\binbox\b/i],
  ["github", /\bgithub\b|\bpull request|\bpr\b/i],
  ["notion", /\bnotion\b/i],
  ["linear", /\blinear\b/i],
  ["calendar", /\bcalendar\b/i],
  ["stripe", /\bstripe\b/i],
  ["hubspot", /\bhubspot\b/i],
  ["salesforce", /\bsalesforce\b/i],
  ["crm", /\bcrm\b/i],
  ["figma", /\bfigma\b/i],
  ["datadog", /\bdatadog\b/i],
  ["sentry", /\bsentry\b/i],
  ["vercel", /\bvercel\b/i],
  ["zendesk", /\bzendesk\b/i],
  ["intercom", /\bintercom\b/i],
  ["postgres", /\bpostgres\b|\bsql\b/i],
  ["gong", /\bgong\b/i],
  ["jira", /\bjira\b/i],
];

/** Canonical integration slugs a template explicitly recommends or clearly mentions. */
export function inferredIntegrations(template: AgentTemplate): string[] {
  const found = new Set<string>(
    (template.recommendedPlugins ?? [])
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
  const haystack = [
    template.name,
    template.summary,
    template.instructions,
    ...template.owns,
    ...template.needsApproval,
  ].join(" ");
  for (const [slug, pattern] of integrationPatterns) {
    if (slug === "crm" && (found.has("hubspot") || found.has("salesforce")))
      continue;
    if (pattern.test(haystack)) found.add(slug);
  }
  return [...found];
}

/** Whether an installed or Composio plugin name matches a recommended integration slug. */
export function pluginMatchesIntegration(
  pluginName: string,
  integration: string,
): boolean {
  const needle = integration.trim().toLowerCase();
  if (!needle) return false;
  const normalized = pluginName
    .trim()
    .toLowerCase()
    .replace(/^@composio\//, "");
  if (normalized === needle) return true;
  return normalized
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .includes(needle);
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
