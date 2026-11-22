import type { PluginView } from "@eta/client-contracts";
import { expect, test } from "nsh/test";
import { cardLogin } from "../src/pages/plugins/plugin-status";

const view = (logins: (string | undefined)[], headers = 0): PluginView =>
  ({
    servers: logins.map((login) => ({ login, headers: Array.from({ length: headers }, () => ({})) })),
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
