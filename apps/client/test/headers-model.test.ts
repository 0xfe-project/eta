import { expect, test } from "nsh/test";
import {
  customHeaderRow,
  defaultHeaderRow,
  hasHeader,
  headerValue,
  incomplete,
  looksSecret,
} from "../src/pages/plugins/headers-model";

test("the primary add is an Authorization row: secret, Bearer, nothing typed", () => {
  expect(defaultHeaderRow()).toEqual({
    name: "Authorization",
    value: "",
    secret: true,
    bearer: true,
  });
  expect(customHeaderRow()).toMatchObject({
    name: "",
    value: "",
    bearer: false,
  });
});

test("an empty value is not saved, a saved secret may be left alone", () => {
  expect(incomplete({ name: "Authorization", value: "", saved: false })).toBe(
    true,
  );
  expect(incomplete({ name: "", value: "x", saved: false })).toBe(true);
  expect(incomplete({ name: "Authorization", value: "", saved: true })).toBe(
    false,
  );
  expect(headerValue("", true)).toBeNull();
  expect(headerValue("abc", true)).toBe("Bearer abc");
  expect(headerValue("abc", false)).toBe("abc");
});

test("an Authorization header already there is found whatever the case", () => {
  expect(hasHeader(["x-api-key", "AUTHORIZATION"], "Authorization")).toBe(true);
  expect(hasHeader(["x-api-key"], "Authorization")).toBe(false);
});

test("the secret toggle starts on for credential-like names", () => {
  for (const name of ["Authorization", "x-api-key", "X-Token", "Cookie"])
    expect(looksSecret(name)).toBe(true);
  expect(looksSecret("X-Team")).toBe(false);
});
