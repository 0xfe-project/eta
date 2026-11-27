import { expect, test } from "nsh/test";
import { createLanguagePreference } from "../src/i18n";
import {
  isLoopbackWebhookUrl,
  providerLabel,
  webhookCurlCommand,
  webhookFullUrl,
} from "../src/pages/routines/schedule";
import {
  buildTriggerConfigPayload,
  enumSelectionValue,
  initialTriggerConfigState,
  parseTriggerConfigSchema,
  validateTriggerField,
} from "../src/pages/routines/trigger-config";

const language = createLanguagePreference();

test("parseTriggerConfigSchema handles types, required, defaults, and deprecated fields", () => {
  const schema: Record<string, unknown> = {
    type: "object",
    required: ["owner", "count"],
    properties: {
      owner: {
        type: "string",
        title: "Owner",
        minLength: 2,
      },
      count: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        default: 10,
      },
      threshold: {
        type: "number",
        exclusiveMinimum: 0,
      },
      include_bots: {
        type: "boolean",
        default: true,
      },
      branch_mode: {
        type: "string",
        enum: ["all", "default"],
        default: "all",
      },
      priority: {
        oneOf: [
          { const: 1, title: "High" },
          { const: 2, title: "Normal" },
        ],
      },
      labels: {
        type: "array",
        items: { type: "string" },
      },
      legacy_skip: {
        type: "string",
        deprecated: true,
      },
      legacy_kept: {
        type: "string",
        deprecated: true,
      },
    },
  };

  const createdFields = parseTriggerConfigSchema(schema);
  expect(createdFields.map((field) => field.key)).toEqual([
    "owner",
    "count",
    "threshold",
    "include_bots",
    "branch_mode",
    "priority",
    "labels",
  ]);
  expect(createdFields.find((f) => f.key === "owner")?.required).toBe(true);
  expect(createdFields.find((f) => f.key === "count")?.kind).toBe("integer");
  expect(createdFields.find((f) => f.key === "threshold")?.kind).toBe("number");
  expect(createdFields.find((f) => f.key === "include_bots")?.kind).toBe(
    "boolean",
  );
  expect(createdFields.find((f) => f.key === "branch_mode")?.kind).toBe("enum");
  expect(createdFields.find((f) => f.key === "priority")?.options).toHaveLength(
    2,
  );
  expect(createdFields.find((f) => f.key === "labels")?.kind).toBe("array");

  // Deprecated fields with an existing saved value are retained and marked deprecated.
  const editedFields = parseTriggerConfigSchema(schema, {
    owner: "octocat",
    legacy_kept: "saved-token",
  });
  const kept = editedFields.find((field) => field.key === "legacy_kept");
  expect(kept).toBeDefined();
  expect(kept?.deprecated).toBe(true);
  expect(kept?.required).toBe(false);
  expect(editedFields.some((f) => f.key === "legacy_skip")).toBe(false);
});

test("initialTriggerConfigState applies defaults without overwriting saved values", () => {
  const fields = parseTriggerConfigSchema({
    type: "object",
    required: ["enabled"],
    properties: {
      owner: { type: "string", default: "default-org" },
      count: { type: "integer", default: 5 },
      enabled: { type: "boolean" },
    },
  });

  const fresh = initialTriggerConfigState(fields);
  expect(fresh.config).toEqual({
    owner: "default-org",
    count: 5,
    enabled: false,
  });
  expect(fresh.drafts).toEqual({ count: "5" });

  const edited = initialTriggerConfigState(fields, {
    owner: "custom-org",
    count: 25,
    enabled: true,
  });
  expect(edited.config).toEqual({
    owner: "custom-org",
    count: 25,
    enabled: true,
  });
  expect(edited.drafts).toEqual({ count: "25" });
});

test("validateTriggerField and buildTriggerConfigPayload enforce schema constraints", () => {
  language.set("en");
  const fields = parseTriggerConfigSchema({
    type: "object",
    required: ["owner", "count"],
    properties: {
      owner: { type: "string", minLength: 2, pattern: "^[a-z0-9-]+$" },
      count: { type: "integer", minimum: 1, maximum: 50 },
      ratio: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
      mode: { type: "string", enum: ["fast", "full"] },
      tags: { type: "array", items: { type: "string" } },
    },
  });

  const owner = fields[0]!;
  const count = fields[1]!;
  const ratio = fields[2]!;
  const mode = fields[3]!;
  const tags = fields[4]!;

  expect(validateTriggerField(owner, {}, {})).toBe("Enter a value.");
  expect(validateTriggerField(owner, { owner: "a" }, {})).toBe(
    "Minimum 2 characters",
  );
  expect(validateTriggerField(owner, { owner: "Bad!" }, {})).toBe(
    "Format does not match requirements.",
  );
  expect(validateTriggerField(owner, { owner: "eta-org" }, {})).toBeUndefined();

  expect(validateTriggerField(count, {}, { count: "1.5" })).toBe(
    "Enter a whole number.",
  );
  expect(validateTriggerField(count, {}, { count: "0" })).toBe("Minimum 1");
  expect(validateTriggerField(count, {}, { count: "51" })).toBe("Maximum 50");
  expect(validateTriggerField(count, {}, { count: "12" })).toBeUndefined();

  expect(validateTriggerField(ratio, {}, { ratio: "0" })).toBe(
    "Must be greater than 0",
  );
  expect(validateTriggerField(ratio, {}, { ratio: "1" })).toBe(
    "Must be less than 1",
  );
  expect(validateTriggerField(ratio, {}, { ratio: "0.5" })).toBeUndefined();

  expect(enumSelectionValue(mode, "full")).toBe("opt:1");
  expect(validateTriggerField(tags, {}, { tags: "[invalid" })).toBe(
    "Enter valid JSON.",
  );
  expect(
    validateTriggerField(tags, {}, { tags: "bug, urgent" }),
  ).toBeUndefined();

  const payload = buildTriggerConfigPayload(
    fields,
    { owner: "eta-org", mode: "full" },
    { count: "12", ratio: "", tags: "bug, urgent" },
  );
  expect(payload).toEqual({
    owner: "eta-org",
    count: 12,
    mode: "full",
    tags: ["bug", "urgent"],
  });
});

test("providerLabel formats built-in rss and other trigger provider ids", () => {
  expect(providerLabel("rss")).toBe("RSS");
  expect(providerLabel("webhook")).toBe("Webhook");
  expect(providerLabel("composio")).toBe("Composio");
  expect(providerLabel("custom_hook")).toBe("Custom Hook");
});

test("webhook URL, loopback detection, and curl command helpers handle all auth modes", () => {
  expect(
    webhookFullUrl(
      {
        path: "/hooks/tok123",
        publicUrl: "https://eta.example.com/hooks/tok123",
      },
      "http://127.0.0.1:4100",
    ),
  ).toBe("https://eta.example.com/hooks/tok123");
  expect(
    webhookFullUrl(
      { path: "/hooks/tok123", publicUrl: null },
      "http://127.0.0.1:4100/",
    ),
  ).toBe("http://127.0.0.1:4100/hooks/tok123");

  expect(isLoopbackWebhookUrl("http://127.0.0.1:4100/hooks/tok123")).toBe(true);
  expect(isLoopbackWebhookUrl("http://localhost:4100/hooks/tok123")).toBe(true);
  expect(isLoopbackWebhookUrl("https://eta.example.com/hooks/tok123")).toBe(
    false,
  );

  expect(
    webhookCurlCommand("https://eta.example.com/hooks/tok123", {
      authMode: "none",
      headerName: null,
    }),
  ).toBe(
    "curl -X POST 'https://eta.example.com/hooks/tok123' -H 'Content-Type: application/json' -d '{\"event\":\"test\"}'",
  );

  expect(
    webhookCurlCommand("https://eta.example.com/hooks/tok123", {
      authMode: "header",
      headerName: "Authorization",
    }),
  ).toContain("-H 'Authorization: Bearer <secret>'");

  expect(
    webhookCurlCommand("https://eta.example.com/hooks/tok123", {
      authMode: "header",
      headerName: "X-Webhook-Secret",
    }),
  ).toContain("-H 'X-Webhook-Secret: <secret>'");

  expect(
    webhookCurlCommand("https://eta.example.com/hooks/tok123", {
      authMode: "hmac-sha256",
      headerName: "X-Hub-Signature-256",
    }),
  ).toContain("-H 'X-Hub-Signature-256: sha256=<hmac-sha256>'");
});
