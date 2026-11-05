/**
 * What a plugin asks the user for: the `config` of `extensions["tech.0xfe.eta"]`, and whether values
 * fit it.
 *
 * Pure functions, shared by the host and the web client, so the two cannot disagree; the host's
 * answer is the one that counts. The schema is closed and small on purpose (it is not JSON Schema):
 * every key it has can be drawn as a form, and a key it does not have makes the whole `config`
 * invalid rather than quietly doing nothing.
 *
 * `pattern` is an author's regular expression run on the host, so it goes through RE2 (`re2js`),
 * which matches in time linear in the input. Lookaround and backreferences are not RE2 and make the
 * `config` invalid. This module is its own entry point because of that dependency: importing it
 * costs a client the engine, and importing the contracts does not.
 */
import { RE2JS } from "re2js";

/** The namespace of eta's private data in a plugin's `extensions`. */
export const ETA_EXTENSION = "tech.0xfe.eta";

export const PLUGIN_FIELD_LIMITS = {
  fields: 64,
  options: 256,
  patternLength: 512,
  /** No string value is longer than this, whatever `maxLength` says. */
  valueLength: 65_536,
} as const;

/**
 * How far an agent may read a field: `none`, not at all; `read`, the value (a field that is not a
 * secret); `file`, a path to a 0600 file holding it; `value`, the plain value (both secrets). The
 * manifest declares the most it allows, and the user can only go lower.
 */
export type PluginAgentLevel = "none" | "read" | "file" | "value";

export type PluginValue = string | number | boolean | string[];

interface FieldBase {
  name: string;
  title: string;
  description: string;
  required: boolean;
  secret: boolean;
  /** The most an agent may do with it, as declared. */
  agent: PluginAgentLevel;
}

export interface StringField extends FieldBase {
  type: "string";
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  default?: string;
}

export interface NumberField extends FieldBase {
  type: "number";
  int: boolean;
  min?: number;
  max?: number;
  default?: number;
}

export interface BooleanField extends FieldBase {
  type: "boolean";
  default?: boolean;
}

export interface SelectField extends FieldBase {
  type: "select";
  options: { value: string; label: string }[];
  multiple: boolean;
  minItems?: number;
  maxItems?: number;
  default?: string | string[];
}

export type PluginField =
  | StringField
  | NumberField
  | BooleanField
  | SelectField;

/** Why a value does not fit its field. `limit` is the bound it broke, when it has one. */
export interface FieldIssue {
  field: string;
  code:
    | "required"
    | "type"
    | "pattern"
    | "minLength"
    | "maxLength"
    | "int"
    | "min"
    | "max"
    | "option"
    | "minItems"
    | "maxItems";
  limit?: number;
}

const FIELD_NAME = /^[a-z_]\w{0,63}$/i;
const COMMON_KEYS = [
  "type",
  "title",
  "description",
  "required",
  "default",
  "secret",
  "agent",
];
const KEYS_OF = {
  string: ["pattern", "minLength", "maxLength"],
  number: ["int", "min", "max"],
  boolean: [],
  select: ["options", "multiple", "minItems", "maxItems"],
} as const;
const LEVELS: readonly PluginAgentLevel[] = ["none", "read", "file", "value"];

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** The levels a field can be set to, lowest first: `none`, and what its kind allows up to `agent`. */
export function agentLevels(field: PluginField): PluginAgentLevel[] {
  const kind: PluginAgentLevel[] = field.secret
    ? ["none", "file", "value"]
    : ["none", "read"];
  return kind.slice(0, kind.indexOf(field.agent) + 1);
}

/**
 * The level in force: what the user chose, or the manifest's when they chose nothing. A choice the
 * manifest no longer allows (an upgrade lowered it) reads as `none` until they choose again.
 */
export function agentLevel(
  field: PluginField,
  chosen: PluginAgentLevel | undefined,
): PluginAgentLevel {
  if (chosen === undefined) return field.agent;
  return agentLevels(field).includes(chosen) ? chosen : "none";
}

function compiled(pattern: string): RE2JS | undefined {
  try {
    return RE2JS.compile(pattern);
  } catch {
    return undefined;
  }
}

/**
 * The `config` object of a manifest, as fields in the order they were declared. Anything wrong
 * with it invalidates all of it: a form that lost a field would let the plugin run without it.
 */
export function parseConfigFields(raw: unknown): {
  fields: PluginField[];
  problems: string[];
} {
  if (raw === undefined) return { fields: [], problems: [] };
  if (!isPlain(raw))
    return { fields: [], problems: ["config must be an object"] };
  const problems: string[] = [];
  const entries = Object.entries(raw);
  if (entries.length > PLUGIN_FIELD_LIMITS.fields)
    problems.push(`config has more than ${PLUGIN_FIELD_LIMITS.fields} fields`);
  const fields: PluginField[] = [];
  for (const [name, spec] of entries) {
    const field = parseField(name, spec, (problem) =>
      problems.push(`config.${name}: ${problem}`),
    );
    if (field !== undefined) fields.push(field);
  }
  return problems.length > 0 ? { fields: [], problems } : { fields, problems };
}

function parseField(
  name: string,
  raw: unknown,
  problem: (text: string) => void,
): PluginField | undefined {
  if (!FIELD_NAME.test(name)) problem("is not a valid field name");
  if (!isPlain(raw)) {
    problem("must be an object");
    return undefined;
  }
  const type = raw.type;
  if (
    type !== "string" &&
    type !== "number" &&
    type !== "boolean" &&
    type !== "select"
  ) {
    problem(`unknown type ${JSON.stringify(type)}`);
    return undefined;
  }
  const known = new Set<string>([...COMMON_KEYS, ...KEYS_OF[type]]);
  for (const key of Object.keys(raw))
    if (!known.has(key)) problem(`unknown key ${key}`);

  const text = (key: string): string | undefined => {
    const value = raw[key];
    if (value === undefined) return undefined;
    if (typeof value === "string") return value;
    problem(`${key} must be a string`);
    return undefined;
  };
  const flag = (key: string): boolean => {
    const value = raw[key];
    if (value === undefined) return false;
    if (typeof value === "boolean") return value;
    problem(`${key} must be true or false`);
    return false;
  };
  const count = (key: string): number | undefined => {
    const value = raw[key];
    if (value === undefined) return undefined;
    if (isCount(value)) return value;
    problem(`${key} must be a whole number of at least 0`);
    return undefined;
  };
  const ordered = (
    low: number | undefined,
    high: number | undefined,
    lowKey: string,
    highKey: string,
  ): void => {
    if (low !== undefined && high !== undefined && low > high)
      problem(`${lowKey} is greater than ${highKey}`);
  };

  const secret = flag("secret");
  const base: FieldBase = {
    name,
    title: text("title") ?? name,
    description: text("description") ?? "",
    required: flag("required"),
    secret,
    agent: secret ? "none" : "read",
  };
  if (secret && type !== "string") problem("secret is only for a string field");
  if (secret && raw.default !== undefined)
    problem("a secret cannot have a default");
  if (raw.agent !== undefined) {
    const agent = raw.agent as PluginAgentLevel;
    const allowed: readonly PluginAgentLevel[] = secret
      ? ["none", "file", "value"]
      : ["none", "read"];
    if (!LEVELS.includes(agent) || !allowed.includes(agent))
      problem(
        `agent must be one of ${allowed.join(", ")} on a ${secret ? "secret" : "field that is not a secret"}`,
      );
    else base.agent = agent;
  }

  let field: PluginField;
  switch (type) {
    case "string": {
      const pattern = text("pattern");
      const minLength = count("minLength");
      const maxLength = count("maxLength");
      ordered(minLength, maxLength, "minLength", "maxLength");
      if (pattern !== undefined) {
        if (pattern.length > PLUGIN_FIELD_LIMITS.patternLength)
          problem(
            `pattern is longer than ${PLUGIN_FIELD_LIMITS.patternLength} characters`,
          );
        else if (compiled(pattern) === undefined)
          problem("pattern is not a regular expression RE2 can run");
      }
      field = {
        ...base,
        type,
        ...(pattern === undefined ? {} : { pattern }),
        ...(minLength === undefined ? {} : { minLength }),
        ...(maxLength === undefined ? {} : { maxLength }),
      };
      break;
    }
    case "number": {
      const bound = (key: string): number | undefined => {
        const value = raw[key];
        if (value === undefined) return undefined;
        if (finite(value)) return value;
        problem(`${key} must be a number`);
        return undefined;
      };
      const min = bound("min");
      const max = bound("max");
      ordered(min, max, "min", "max");
      field = {
        ...base,
        type,
        int: flag("int"),
        ...(min === undefined ? {} : { min }),
        ...(max === undefined ? {} : { max }),
      };
      break;
    }
    case "boolean":
      field = { ...base, type };
      break;
    case "select": {
      const options = parseOptions(raw.options, problem);
      const multiple = flag("multiple");
      const minItems = count("minItems");
      const maxItems = count("maxItems");
      ordered(minItems, maxItems, "minItems", "maxItems");
      if (!multiple && (minItems !== undefined || maxItems !== undefined))
        problem("minItems and maxItems need multiple");
      field = {
        ...base,
        type,
        options,
        multiple,
        ...(minItems === undefined ? {} : { minItems }),
        ...(maxItems === undefined ? {} : { maxItems }),
      };
      break;
    }
  }
  if (raw.default !== undefined) {
    const issue = valueIssue(field, raw.default as PluginValue);
    if (issue !== undefined) problem(`default does not fit: ${issue.code}`);
    else (field as { default?: unknown }).default = raw.default;
  }
  return field;
}

function parseOptions(
  raw: unknown,
  problem: (text: string) => void,
): SelectField["options"] {
  if (!Array.isArray(raw) || raw.length === 0) {
    problem("options must be a list with something in it");
    return [];
  }
  if (raw.length > PLUGIN_FIELD_LIMITS.options)
    problem(`options has more than ${PLUGIN_FIELD_LIMITS.options} entries`);
  const options: SelectField["options"] = [];
  const seen = new Set<string>();
  for (const option of raw as unknown[]) {
    if (
      !isPlain(option) ||
      typeof option.value !== "string" ||
      option.value === "" ||
      typeof option.label !== "string" ||
      Object.keys(option).some((key) => key !== "value" && key !== "label")
    ) {
      problem("each option is { value, label }, both strings");
      continue;
    }
    if (seen.has(option.value))
      problem(`option ${option.value} is listed twice`);
    seen.add(option.value);
    options.push({ value: option.value, label: option.label });
  }
  return options;
}

const isEmpty = (value: PluginValue | null | undefined): boolean =>
  value === undefined ||
  value === null ||
  value === "" ||
  (Array.isArray(value) && value.length === 0);

/** What a value fits or breaks, for a value that is there. */
function valueIssue(
  field: PluginField,
  value: PluginValue,
): FieldIssue | undefined {
  const issue = (
    code: FieldIssue["code"],
    limit?: number,
  ): FieldIssue | undefined => ({
    field: field.name,
    code,
    ...(limit === undefined ? {} : { limit }),
  });
  switch (field.type) {
    case "string": {
      if (typeof value !== "string") return issue("type");
      const maxLength = Math.min(
        field.maxLength ?? PLUGIN_FIELD_LIMITS.valueLength,
        PLUGIN_FIELD_LIMITS.valueLength,
      );
      // Length first: the expression is only ever run on an input of bounded size.
      if (value.length > maxLength) return issue("maxLength", maxLength);
      if (field.minLength !== undefined && value.length < field.minLength)
        return issue("minLength", field.minLength);
      if (
        field.pattern !== undefined &&
        compiled(field.pattern)?.matcher(value).find() !== true
      )
        return issue("pattern");
      return undefined;
    }
    case "number":
      if (!finite(value)) return issue("type");
      if (field.int && !Number.isInteger(value)) return issue("int");
      if (field.min !== undefined && value < field.min)
        return issue("min", field.min);
      if (field.max !== undefined && value > field.max)
        return issue("max", field.max);
      return undefined;
    case "boolean":
      return typeof value === "boolean" ? undefined : issue("type");
    case "select": {
      const chosen = field.multiple ? value : [value];
      if (
        !Array.isArray(chosen) ||
        new Set(chosen).size !== chosen.length ||
        chosen.some((item) => typeof item !== "string")
      )
        return issue("type");
      if (
        chosen.some(
          (item) => !field.options.some((option) => option.value === item),
        )
      )
        return issue("option");
      if (field.minItems !== undefined && chosen.length < field.minItems)
        return issue("minItems", field.minItems);
      if (field.maxItems !== undefined && chosen.length > field.maxItems)
        return issue("maxItems", field.maxItems);
      return undefined;
    }
  }
}

/** The value in force: what was saved, else the field's default. */
export function effectiveValue(
  field: PluginField,
  saved: PluginValue | null | undefined,
): PluginValue | undefined {
  return isEmpty(saved) ? field.default : (saved as PluginValue);
}

/** One field's value, saved or left to its default: what is wrong with it, or nothing. */
export function fieldIssue(
  field: PluginField,
  saved: PluginValue | null | undefined,
): FieldIssue | undefined {
  const value = effectiveValue(field, saved);
  if (value === undefined || isEmpty(value))
    return field.required ? { field: field.name, code: "required" } : undefined;
  return valueIssue(field, value);
}

/** Everything wrong with a set of values; empty means a plugin can be enabled with them. */
export function configIssues(
  fields: readonly PluginField[],
  values: Readonly<Record<string, PluginValue | null | undefined>>,
): FieldIssue[] {
  return fields.flatMap((field) => {
    const issue = fieldIssue(field, values[field.name]);
    return issue === undefined ? [] : [issue];
  });
}
