import { expect, test } from "nsh/test";
import { showsWorkspace } from "../src/app/workspace-gate";

const warm = {
  connected: true,
  everConnected: true,
  changingHost: false,
  settled: true,
};

test("a cold start shows the connection page", () => {
  expect(
    showsWorkspace({ ...warm, connected: false, everConnected: false }),
  ).toBe(false);
});

test("a socket that dropped after the app was online keeps the workspace", () => {
  expect(showsWorkspace({ ...warm, connected: false })).toBe(true);
});

test("a reconnect in progress is not a reason to throw the workspace away", () => {
  // What the app does on waking up: the wire starts over, so it is not connected yet.
  expect(
    showsWorkspace({ ...warm, connected: false, everConnected: true }),
  ).toBe(true);
});

test("the retry loop giving up is not a reason either", () => {
  const retriesGaveUp = { ...warm, connected: false, everConnected: true };
  expect(showsWorkspace(retriesGaveUp)).toBe(true);
});

test("asking for another host shows the connection page", () => {
  expect(showsWorkspace({ ...warm, changingHost: true })).toBe(false);
  expect(
    showsWorkspace({ ...warm, connected: false, changingHost: true }),
  ).toBe(false);
});

test("nothing is drawn before the web workspace has settled", () => {
  expect(showsWorkspace({ ...warm, settled: false })).toBe(false);
});
