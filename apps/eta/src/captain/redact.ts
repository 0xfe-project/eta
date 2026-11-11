const SECRET_KEY =
  /api[_-]?key|authorization|cookie|password|passwd|secret|token|private[_-]?key|client[_-]?secret/i;
const SECRET_TEXT = [
  /\bsk-[\w-]{12,}\b/g,
  /\bxai-[\w-]{12,}\b/g,
  /\bAIza[\w-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_\w{20,}\b/g,
  /\betak\.[\w.-]+\b/g,
  /\bBearer\s+[\w.~+/=-]{12,}\b/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const REDACTED = "[REDACTED:secret]";

export function redactText(text: string): string {
  let out = text;
  for (const pattern of SECRET_TEXT) out = out.replace(pattern, REDACTED);
  return out;
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 20) return "[TRUNCATED:depth]";
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean")
    return value;
  if (Array.isArray(value))
    return value.slice(0, 500).map((item) => redactValue(item, depth + 1));
  if (typeof value !== "object") return String(value);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      key === "data" &&
      (value as Record<string, unknown>).type === "image" &&
      typeof item === "string"
    ) {
      out.data = "";
      continue;
    }
    out[key] = SECRET_KEY.test(key) ? REDACTED : redactValue(item, depth + 1);
  }
  return out;
}

export function redactJson(value: unknown): string {
  return JSON.stringify(redactValue(value), null, 2);
}

/**
 * A tool result crosses the same boundary as a Captain read. Text and structured details are
 * redacted; image blocks stay images, because their bytes are the attachment the Captain was
 * allowed to inspect and a base64 string is not a credential.
 */
export function redactToolResult(result: unknown): unknown {
  if (typeof result === "string") return redactText(result);
  if (Array.isArray(result))
    return result.slice(0, 500).map((item) => redactToolResult(item));
  if (result === null || typeof result !== "object") return result;

  const source = result as Record<string, unknown>;
  const content = source.content;
  if (!Array.isArray(content))
    return redactValue(source) as Record<string, unknown>;

  return {
    ...source,
    content: content.map((block) => {
      if (typeof block !== "object" || block === null)
        return redactValue(block);
      const item = block as Record<string, unknown>;
      if (item.type === "image") return item;
      if (typeof item.text === "string")
        return { ...item, text: redactText(item.text) };
      return redactValue(item);
    }),
    ...(source.details === undefined
      ? {}
      : { details: redactValue(source.details) }),
  };
}
