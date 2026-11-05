// Ported from pi-mcp-adapter/json-schema-validator.ts (MIT, see ../NOTICE), plus the argument handling of utils.ts#normalizeToolArguments.
/**
 * JSON Schema validation for tool arguments and `structuredContent`.
 *
 * MCP servers write draft-07 or 2020-12 schemas, often with `format`s Ajv does not know (Rust
 * `schemars` numbers); one validator per dialect, unknown formats tolerated.
 */
import type {
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator as JsonSchemaValidatorProvider,
} from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { Ajv } from "ajv";
import addFormatsImport from "ajv-formats";
import Ajv2020Import from "ajv/dist/2020.js";

// ajv-formats types target its bundled ajv; the runtime accepts both instances.
const addFormats = addFormatsImport as unknown as (instance: Ajv) => void;

// `type`, `minimum` and `maximum` already carry the constraint of these numeric formats; accepting
// them only stops "unknown format" noise. int32, int64, float and double are left to ajv-formats.
const SCHEMARS_NUMERIC_FORMATS = [
  "int",
  "int8",
  "int16",
  "int128",
  "uint",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "uint128",
];

function addKnownFormats(ajv: Ajv): void {
  addFormats(ajv);
  for (const format of SCHEMARS_NUMERIC_FORMATS) ajv.addFormat(format, true);
}

const DRAFT_07 = new Set([
  "http://json-schema.org/draft-07/schema",
  "https://json-schema.org/draft-07/schema",
]);
const DRAFT_2020_12 = new Set(["https://json-schema.org/draft/2020-12/schema"]);

export function createJsonSchemaValidator(): JsonSchemaValidatorProvider {
  let draft07: AjvJsonSchemaValidator | undefined;
  let draft2020: AjvJsonSchemaValidator | undefined;

  return {
    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
      const stamped =
        typeof schema.$schema === "string"
          ? schema.$schema.replace(/#$/, "")
          : undefined;
      if (stamped === undefined || DRAFT_2020_12.has(stamped)) {
        draft2020 ??= (() => {
          const Ajv2020 = Ajv2020Import as unknown as typeof Ajv;
          const ajv = new Ajv2020({ strict: false, allErrors: true });
          addKnownFormats(ajv);
          return new AjvJsonSchemaValidator(ajv);
        })();
        return draft2020.getValidator<T>(schema);
      }
      if (!DRAFT_07.has(stamped)) {
        throw new Error(`Unsupported JSON Schema dialect: ${stamped}`);
      }
      draft07 ??= (() => {
        const ajv = new Ajv({
          strict: false,
          validateFormats: true,
          validateSchema: false,
          allErrors: true,
        });
        addKnownFormats(ajv);
        return new AjvJsonSchemaValidator(ajv);
      })();
      return draft07.getValidator<T>(schema);
    },
  };
}

const compiled = new WeakMap<object, JsonSchemaValidator<unknown> | null>();
const provider = createJsonSchemaValidator();

/**
 * Why `value` does not match `schema`, or undefined when it does. A schema this library cannot
 * evaluate (an unknown dialect, a broken `$ref`) counts as matching: the server judges those.
 */
export function schemaViolation(
  schema: unknown,
  value: unknown,
): string | undefined {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return undefined;
  }
  let validate = compiled.get(schema);
  if (validate === undefined) {
    try {
      validate = provider.getValidator(schema as JsonSchemaType);
    } catch {
      validate = null;
    }
    compiled.set(schema, validate);
  }
  if (validate === null) return undefined;
  try {
    const result = validate(value);
    return result.valid
      ? undefined
      : (result.errorMessage ?? "does not match the schema");
  } catch {
    return undefined;
  }
}
