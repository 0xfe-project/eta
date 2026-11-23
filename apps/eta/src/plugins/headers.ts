/**
 * The request headers a user attaches to a plugin's remote MCP server: what a header may be, and
 * which names are treated as secrets unless the user says otherwise. Nothing here sees a value
 * except to check it; a value is never put in a message.
 */

/** An HTTP field name: a token (RFC 9110), so no space, colon, CR or LF can slip in. */
const NAME = /^[!#$%&'*+.^\w`|~-]+$/;
const MAX_NAME = 128;
const MAX_VALUE = 4096;
export const MAX_HEADERS_PER_SERVER = 32;

export const MAX_ENV_PER_SERVER = 32;
const ENV_NAME = /^[A-Z_]\w*$/i;

/** Why an environment variable cannot be used, or undefined when it can. Never includes the value. */
export function envProblem(name: string, value: string): string | undefined {
  if (!ENV_NAME.test(name) || name.length > MAX_NAME)
    return `${JSON.stringify(name)} is not a valid variable name`;
  if (value === "") return `variable ${name} needs a value`;
  if (value.length > MAX_VALUE)
    return `the value of ${name} is longer than ${MAX_VALUE}`;
  if (value.includes("\0")) return `the value of ${name} has a NUL`;
  return undefined;
}

/** Why a header cannot be used, or undefined when it can. Never includes the value. */
export function headerProblem(name: string, value: string): string | undefined {
  if (name.trim() === "") return "a header needs a name";
  if (name.length > MAX_NAME) return `header name is longer than ${MAX_NAME}`;
  if (!NAME.test(name))
    return `${JSON.stringify(name)} is not a valid header name`;
  if (value === "") return `header ${name} needs a value`;
  if (value.length > MAX_VALUE)
    return `the value of ${name} is longer than ${MAX_VALUE}`;
  // CR, LF and NUL would end the header or the request line: never allowed.
  if (/[\r\n\0]/.test(value))
    return `the value of ${name} has a line break or NUL`;
  return undefined;
}
