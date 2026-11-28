import { uiText } from "../../i18n";

type TriggerFieldKind =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "enum"
  | "array"
  | "object";

interface TriggerEnumOption {
  value: string;
  label: string;
  raw: unknown;
}

export interface TriggerConfigField {
  key: string;
  title: string;
  description: string;
  kind: TriggerFieldKind;
  required: boolean;
  deprecated: boolean;
  defaultValue: unknown;
  placeholder: string;
  secret: boolean;
  multiline: boolean;
  options: TriggerEnumOption[];
  arrayItemKind?: "string" | "number" | "integer" | "other";
  objectValueType?: "string";
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaTypeOf(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.type === "string") return raw.type;
  if (Array.isArray(raw.type)) {
    const nonNull = raw.type.find(
      (item): item is string => typeof item === "string" && item !== "null",
    );
    return nonNull;
  }
  return undefined;
}

function enumOptionsOf(raw: Record<string, unknown>): TriggerEnumOption[] {
  if (Array.isArray(raw.enum) && raw.enum.length > 0) {
    const names = Array.isArray(raw.enumNames) ? raw.enumNames : [];
    return raw.enum.map((item, index) => ({
      value: `opt:${index}`,
      label:
        typeof names[index] === "string" && names[index].trim() !== ""
          ? names[index]
          : String(item),
      raw: item,
    }));
  }
  const union = Array.isArray(raw.oneOf)
    ? raw.oneOf
    : Array.isArray(raw.anyOf)
      ? raw.anyOf
      : null;
  if (!union) return [];
  const branches = union.filter(
    (entry): entry is Record<string, unknown> =>
      isPlain(entry) && entry.type !== "null",
  );
  if (
    branches.length > 0 &&
    branches.every((entry) => Object.hasOwn(entry, "const"))
  ) {
    return branches.map((entry, index) => ({
      value: `opt:${index}`,
      label:
        typeof entry.title === "string" && entry.title.trim() !== ""
          ? entry.title.trim()
          : String(entry.const),
      raw: entry.const,
    }));
  }
  return [];
}

function placeholderOf(raw: Record<string, unknown>): string {
  if (
    typeof raw.default === "string" ||
    typeof raw.default === "number" ||
    typeof raw.default === "boolean"
  ) {
    return String(raw.default);
  }
  if (Array.isArray(raw.examples) && raw.examples.length > 0) {
    const first = raw.examples[0];
    if (
      typeof first === "string" ||
      typeof first === "number" ||
      typeof first === "boolean"
    ) {
      return String(first);
    }
  }
  return "";
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Parses a JSON Schema `configSchema` into typed field specs.
 * Deprecated properties are skipped unless `existingConfig` already carries a saved value for them.
 */
export function parseTriggerConfigSchema(
  schema: Record<string, unknown> | undefined,
  existingConfig?: Record<string, unknown>,
): TriggerConfigField[] {
  if (!schema || !isPlain(schema.properties)) return [];
  const requiredKeys = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
  );
  const fields: TriggerConfigField[] = [];
  for (const [key, raw] of Object.entries(schema.properties)) {
    if (!isPlain(raw)) continue;
    const deprecated = raw.deprecated === true;
    const hasSaved = existingConfig
      ? Object.hasOwn(existingConfig, key)
      : false;
    if (deprecated && !hasSaved) continue;

    const options = enumOptionsOf(raw);
    const schemaType = schemaTypeOf(raw);
    let kind: TriggerFieldKind;
    if (options.length > 0) kind = "enum";
    else if (schemaType === "boolean") kind = "boolean";
    else if (schemaType === "integer") kind = "integer";
    else if (schemaType === "number") kind = "number";
    else if (schemaType === "array") kind = "array";
    else if (schemaType === "object") kind = "object";
    else kind = "string";

    const itemsType = isPlain(raw.items) ? schemaTypeOf(raw.items) : undefined;
    const arrayItemKind =
      itemsType === "string" ||
      itemsType === "number" ||
      itemsType === "integer"
        ? itemsType
        : "other";

    const objectValueType =
      kind === "object" &&
      isPlain(raw.additionalProperties) &&
      schemaTypeOf(raw.additionalProperties) === "string"
        ? ("string" as const)
        : undefined;

    fields.push({
      key,
      title:
        typeof raw.title === "string" && raw.title.trim() !== ""
          ? raw.title.trim()
          : key,
      description:
        typeof raw.description === "string" ? raw.description.trim() : "",
      kind,
      required: !deprecated && (requiredKeys.has(key) || raw.required === true),
      deprecated,
      defaultValue: raw.default,
      placeholder: placeholderOf(raw),
      secret: raw.format === "password" || raw.writeOnly === true,
      multiline: raw.format === "textarea",
      options,
      arrayItemKind,
      objectValueType,
      minLength: finiteOrUndefined(raw.minLength),
      maxLength: finiteOrUndefined(raw.maxLength),
      pattern: typeof raw.pattern === "string" ? raw.pattern : undefined,
      minimum: finiteOrUndefined(raw.minimum),
      maximum: finiteOrUndefined(raw.maximum),
      exclusiveMinimum: finiteOrUndefined(raw.exclusiveMinimum),
      exclusiveMaximum: finiteOrUndefined(raw.exclusiveMaximum),
    });
  }
  return fields;
}

export function initialTriggerConfigState(
  fields: readonly TriggerConfigField[],
  existingConfig?: Record<string, unknown>,
): { config: Record<string, unknown>; drafts: Record<string, string> } {
  const config: Record<string, unknown> = {};
  const drafts: Record<string, string> = {};

  if (fields.length === 0 && existingConfig) {
    return { config: { ...existingConfig }, drafts };
  }

  for (const field of fields) {
    const hasSaved = existingConfig
      ? Object.hasOwn(existingConfig, field.key)
      : false;
    const rawValue = hasSaved
      ? existingConfig![field.key]
      : field.defaultValue !== undefined
        ? field.defaultValue
        : field.kind === "boolean" && field.required
          ? false
          : undefined;

    if (rawValue !== undefined) {
      config[field.key] = rawValue;
      if (field.kind === "number" || field.kind === "integer") {
        drafts[field.key] = String(rawValue);
      } else if (field.kind === "array") {
        drafts[field.key] = Array.isArray(rawValue)
          ? rawValue.every(
              (item) => typeof item === "string" || typeof item === "number",
            )
            ? rawValue.map(String).join(", ")
            : JSON.stringify(rawValue)
          : String(rawValue);
      } else if (field.kind === "object") {
        drafts[field.key] =
          typeof rawValue === "string" ? rawValue : JSON.stringify(rawValue);
      }
    }
  }
  return { config, drafts };
}

export function enumSelectionValue(
  field: TriggerConfigField,
  current: unknown,
): string | null {
  const matched = field.options.find((option) =>
    Object.is(option.raw, current),
  );
  return matched ? matched.value : null;
}

function parseArrayDraft(
  field: TriggerConfigField,
  rawText: string,
): { ok: true; value: unknown[] | undefined } | { ok: false; error: string } {
  const trimmed = rawText.trim();
  if (trimmed === "") return { ok: true, value: undefined };
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!Array.isArray(parsed))
        return { ok: false, error: uiText("triggerFieldJsonInvalid") };
      return { ok: true, value: parsed };
    } catch {
      return { ok: false, error: uiText("triggerFieldJsonInvalid") };
    }
  }
  if (field.arrayItemKind === "other") {
    return { ok: false, error: uiText("triggerFieldJsonInvalid") };
  }
  const parts = trimmed
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (field.arrayItemKind === "number" || field.arrayItemKind === "integer") {
    const nums: number[] = [];
    for (const part of parts) {
      const num = Number(part);
      if (!Number.isFinite(num))
        return { ok: false, error: uiText("pluginNumberRequired") };
      if (field.arrayItemKind === "integer" && !Number.isInteger(num))
        return { ok: false, error: uiText("pluginWholeNumberRequired") };
      nums.push(num);
    }
    return { ok: true, value: nums };
  }
  return { ok: true, value: parts };
}

function parseObjectDraft(
  rawText: string,
  field?: TriggerConfigField,
):
  | { ok: true; value: Record<string, unknown> | undefined }
  | { ok: false; error: string } {
  const trimmed = rawText.trim();
  if (trimmed === "") return { ok: true, value: undefined };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isPlain(parsed))
      return { ok: false, error: uiText("triggerFieldJsonInvalid") };
    if (
      field?.objectValueType === "string" &&
      Object.values(parsed).some((value) => typeof value !== "string")
    ) {
      return { ok: false, error: uiText("triggerFieldStringValuesOnly") };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, error: uiText("triggerFieldJsonInvalid") };
  }
}

export function validateTriggerField(
  field: TriggerConfigField,
  config: Record<string, unknown>,
  drafts: Record<string, string>,
  provider?: string,
): string | undefined {
  const current = config[field.key];
  if (
    provider === "web-monitor" &&
    (field.key === "selector" || field.key === "jsonPath")
  ) {
    const selectorText =
      typeof config.selector === "string" ? config.selector.trim() : "";
    const jsonPathText =
      typeof config.jsonPath === "string" ? config.jsonPath.trim() : "";
    if (selectorText !== "" && jsonPathText !== "") {
      return uiText("triggerWebMonitorSelectorConflict");
    }
  }
  switch (field.kind) {
    case "enum":
      if (field.required && (current === undefined || current === null)) {
        return uiText("triggerFieldEnterValue");
      }
      return undefined;
    case "boolean":
      if (field.required && typeof current !== "boolean") {
        return uiText("triggerFieldEnterValue");
      }
      return undefined;
    case "number":
    case "integer": {
      const raw = Object.hasOwn(drafts, field.key)
        ? drafts[field.key]!
        : current !== undefined && current !== null
          ? String(current)
          : "";
      const trimmed = raw.trim();
      if (trimmed === "") {
        return field.required ? uiText("triggerFieldEnterValue") : undefined;
      }
      const num = Number(trimmed);
      if (!Number.isFinite(num)) return uiText("pluginNumberRequired");
      if (field.kind === "integer" && !Number.isInteger(num)) {
        return uiText("pluginWholeNumberRequired");
      }
      if (field.minimum !== undefined && num < field.minimum) {
        return uiText("pluginBelowMinimum", { value: field.minimum });
      }
      if (
        field.exclusiveMinimum !== undefined &&
        num <= field.exclusiveMinimum
      ) {
        return uiText("triggerFieldExclusiveMin", {
          value: field.exclusiveMinimum,
        });
      }
      if (field.maximum !== undefined && num > field.maximum) {
        return uiText("pluginAboveMaximum", { value: field.maximum });
      }
      if (
        field.exclusiveMaximum !== undefined &&
        num >= field.exclusiveMaximum
      ) {
        return uiText("triggerFieldExclusiveMax", {
          value: field.exclusiveMaximum,
        });
      }
      return undefined;
    }
    case "array": {
      const raw = Object.hasOwn(drafts, field.key)
        ? drafts[field.key]!
        : Array.isArray(current)
          ? JSON.stringify(current)
          : "";
      const parsed = parseArrayDraft(field, raw);
      if (!parsed.ok) return parsed.error;
      if (field.required && (!parsed.value || parsed.value.length === 0)) {
        return uiText("triggerFieldArrayRequired");
      }
      return undefined;
    }
    case "object": {
      const raw = Object.hasOwn(drafts, field.key)
        ? drafts[field.key]!
        : isPlain(current)
          ? JSON.stringify(current)
          : "";
      const parsed = parseObjectDraft(raw, field);
      if (!parsed.ok) return parsed.error;
      if (field.required && parsed.value === undefined) {
        return uiText("triggerFieldEnterValue");
      }
      return undefined;
    }
    case "string": {
      const text =
        typeof current === "string"
          ? current
          : current !== undefined && current !== null
            ? String(current)
            : "";
      if (text.trim() === "") {
        return field.required ? uiText("triggerFieldEnterValue") : undefined;
      }
      if (field.minLength !== undefined && text.length < field.minLength) {
        return uiText("triggerFieldMinLength", { count: field.minLength });
      }
      if (field.maxLength !== undefined && text.length > field.maxLength) {
        return uiText("triggerFieldMaxLength", { count: field.maxLength });
      }
      if (field.pattern) {
        try {
          if (!new RegExp(field.pattern).test(text)) {
            return uiText("triggerFieldPattern");
          }
        } catch {
          // Ignore invalid regex patterns supplied by external schemas.
        }
      }
      return undefined;
    }
  }
}

export function buildTriggerConfigPayload(
  fields: readonly TriggerConfigField[],
  config: Record<string, unknown>,
  drafts: Record<string, string>,
): Record<string, unknown> {
  if (fields.length === 0) return { ...config };
  const payload: Record<string, unknown> = {};
  for (const field of fields) {
    const current = config[field.key];
    switch (field.kind) {
      case "enum":
        if (current !== undefined && current !== null) {
          payload[field.key] = current;
        }
        break;
      case "boolean":
        if (typeof current === "boolean") payload[field.key] = current;
        break;
      case "number":
      case "integer": {
        const raw = Object.hasOwn(drafts, field.key)
          ? drafts[field.key]!.trim()
          : current !== undefined && current !== null
            ? String(current)
            : "";
        if (raw !== "") {
          const num = Number(raw);
          if (Number.isFinite(num)) payload[field.key] = num;
        }
        break;
      }
      case "array": {
        const raw = Object.hasOwn(drafts, field.key)
          ? drafts[field.key]!
          : Array.isArray(current)
            ? JSON.stringify(current)
            : "";
        const parsed = parseArrayDraft(field, raw);
        if (parsed.ok && parsed.value !== undefined) {
          payload[field.key] = parsed.value;
        }
        break;
      }
      case "object": {
        const raw = Object.hasOwn(drafts, field.key)
          ? drafts[field.key]!
          : isPlain(current)
            ? JSON.stringify(current)
            : "";
        const parsed = parseObjectDraft(raw, field);
        if (parsed.ok && parsed.value !== undefined) {
          payload[field.key] = parsed.value;
        }
        break;
      }
      case "string": {
        const text =
          typeof current === "string"
            ? current
            : current !== undefined && current !== null
              ? String(current)
              : "";
        if (text !== "" || field.required) {
          if (text !== "") payload[field.key] = text;
        }
        break;
      }
    }
  }
  return payload;
}
