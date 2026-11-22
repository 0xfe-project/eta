/** Names whose value is a credential: the "secret" toggle starts on for these. */
const SECRET_NAME = /authorization|key|token|secret|auth|cookie|password/i;
export const looksSecret = (name: string): boolean => SECRET_NAME.test(name);

/** Whether a header of this name is in the list, whatever the case. */
export const hasHeader = (names: readonly string[], name: string): boolean =>
  names.some((one) => one.toLowerCase() === name.toLowerCase());

/** The row the primary "add" makes: Authorization, a secret, a Bearer token still to be pasted. */
export const defaultHeaderRow = () => ({
  name: "Authorization",
  value: "",
  secret: true,
  bearer: true,
});

/** The row "custom header" makes: nothing prefilled; the secret toggle follows the name once typed. */
export const customHeaderRow = () => ({
  name: "",
  value: "",
  secret: false,
  bearer: false,
});

/** The value to save: a Bearer token is sent as `Bearer <token>`; empty means "keep what is saved". */
export const headerValue = (value: string, bearer: boolean): string | null =>
  value === "" ? null : bearer ? `Bearer ${value}` : value;

/** A row that cannot be saved: no name, or no value and nothing saved under it. */
export const incomplete = (row: {
  name: string;
  value: string;
  saved: boolean;
}): boolean => row.name.trim() === "" || (row.value === "" && !row.saved);
