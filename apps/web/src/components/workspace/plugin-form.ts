import type {
  FieldIssue,
  PluginFieldView,
  PluginValue,
} from "@eta/client-contracts";
import { fieldIssue } from "@eta/client-contracts/plugin-fields";

// A plugin's form, as data: what each control holds and what it would send. The rules are the
// same module the host checks with; the host's answer is still the one that counts. A secret starts
// blank and stays blank unless it is being replaced: left blank, it means "keep what is saved".

export type FieldDraft = string | boolean | string[];
export type PluginDraft = Record<string, FieldDraft>;

function initial(field: PluginFieldView): FieldDraft {
  if (field.secret) return "";
  const value = field.value ?? field.default;
  if (field.type === "boolean") return value === true;
  if (field.type === "select" && field.multiple)
    return Array.isArray(value) ? value : [];
  return value === undefined ? "" : String(value);
}

export function draftOf(fields: readonly PluginFieldView[]): PluginDraft {
  return Object.fromEntries(
    fields.map((field) => [field.name, initial(field)]),
  );
}

/** What a control holds as a value; `null` is nothing. */
function parsed(field: PluginFieldView, draft: FieldDraft): PluginValue | null {
  if (draft === "") return null;
  if (field.type === "number") return Number(draft);
  return draft;
}

/** What is wrong with what a control holds, by the same rules the host applies. */
export function issueOf(
  field: PluginFieldView,
  draft: FieldDraft,
): FieldIssue | undefined {
  if (field.secret && draft === "")
    return field.set || !field.required
      ? undefined
      : { field: field.name, code: "required" };
  return fieldIssue(field, parsed(field, draft));
}

/** What the form says: what cannot be saved at all, and whether it is still missing something. */
export function formState(
  fields: readonly PluginFieldView[],
  draft: PluginDraft,
): { issues: Record<string, FieldIssue>; invalid: boolean; complete: boolean } {
  const issues: Record<string, FieldIssue> = {};
  for (const field of fields) {
    const issue = issueOf(field, draft[field.name] ?? "");
    if (issue !== undefined) issues[field.name] = issue;
  }
  const found = Object.values(issues);
  return {
    issues,
    invalid: found.some((issue) => issue.code !== "required"),
    complete: found.length === 0,
  };
}

const same = (a: FieldDraft, b: FieldDraft): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** What to send: what changed, and a required value that is only a default on the screen. */
export function changes(
  fields: readonly PluginFieldView[],
  draft: PluginDraft,
): Record<string, PluginValue | null> {
  const start = draftOf(fields);
  const out: Record<string, PluginValue | null> = {};
  for (const field of fields) {
    const value = draft[field.name] ?? "";
    if (field.secret) {
      if (value !== "") out[field.name] = value;
      continue;
    }
    if (!same(value, start[field.name] ?? "") || (field.required && !field.set))
      out[field.name] = parsed(field, value);
  }
  return out;
}
