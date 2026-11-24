import type { PluginView } from "@eta/client-contracts";
import { expect, test } from "nsh/test";
import { authStyle, cardLogin } from "../src/pages/plugins/plugin-status";

const view = (logins: (string | undefined)[], headers = 0): PluginView =>
  ({
    servers: logins.map((login) => ({
      login,
      headers: Array.from({ length: headers }, () => ({})),
    })),
  }) as unknown as PluginView;

test("any server that needs login makes the card need login", () => {
  expect(cardLogin(view(["signed_in", "needs_login"]))).toBe("needs_login");
});
test("signed in only when every login-requiring server is", () => {
  expect(cardLogin(view(["signed_in", "none"]))).toBe("signed_in");
});
test("no evidence, no servers, or header-only servers show nothing", () => {
  expect(cardLogin(view([]))).toBeUndefined();
  expect(cardLogin(view(["none", undefined]))).toBeUndefined();
  expect(cardLogin(view(["needs_login"], 1))).toBeUndefined();
});

const cursor = (server: Record<string, unknown>): PluginView =>
  ({ servers: [server] }) as unknown as PluginView;

test("a Cursor server with no Cursor sign-in makes the card need login, with no test run", () => {
  expect(cardLogin(cursor({ cursorServer: true, cursorSignedIn: false }))).toBe(
    "needs_login",
  );
  expect(cardLogin(cursor({ cursorServer: true }))).toBe("needs_login");
  expect(
    cardLogin(
      cursor({ cursorServer: true, cursorSignedIn: false, login: "none" }),
    ),
  ).toBe("needs_login");
});

test("a Cursor server that is signed in does not", () => {
  expect(
    cardLogin(cursor({ cursorServer: true, cursorSignedIn: true })),
  ).not.toBe("needs_login");
  expect(
    cardLogin(
      cursor({
        cursorServer: true,
        cursorSignedIn: false,
        login: "signed_in",
      }),
    ),
  ).not.toBe("needs_login");
});

test("a server that is not Cursor's is not made to need login by the Cursor flag", () => {
  expect(
    cardLogin(cursor({ cursorServer: false, cursorSignedIn: false })),
  ).toBeUndefined();
  expect(cardLogin(cursor({ cursorSignedIn: false }))).toBeUndefined();
});

test("the badge is a quiet tint: the state's fill token, never a solid colour", () => {
  expect(authStyle("signed_in")).toMatchObject({
    tone: "green",
    fill: "greenFill",
  });
  expect(authStyle("expired")).toMatchObject({
    tone: "red",
    fill: "redFill",
  });
  expect(authStyle("needs_login")).toMatchObject({
    tone: "warningInk",
    fill: "warningFill",
  });
  expect(authStyle("needs_setup")).toMatchObject({
    tone: "warningInk",
    fill: "warningFill",
  });
});
