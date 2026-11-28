import { expect, test } from "nsh/test";
import {
  canReturnToWorkspace,
  showsPhoneHostSetup,
  showsWorkspace,
} from "../src/app/workspace-gate";

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

test("asking for another host shows the connection page", () => {
  expect(showsWorkspace({ ...warm, changingHost: true })).toBe(false);
  expect(
    showsWorkspace({ ...warm, connected: false, changingHost: true }),
  ).toBe(false);
});

test("nothing is drawn before the web workspace has settled", () => {
  expect(showsWorkspace({ ...warm, settled: false })).toBe(false);
});

test("canReturnToWorkspace allows cancelling back only over a live or previously connected workspace", () => {
  expect(canReturnToWorkspace({ ...warm, changingHost: true })).toBe(true);
  expect(
    canReturnToWorkspace({ ...warm, connected: false, changingHost: true }),
  ).toBe(true);
  expect(canReturnToWorkspace(warm)).toBe(false);
  expect(
    canReturnToWorkspace({
      ...warm,
      connected: false,
      everConnected: false,
      changingHost: true,
    }),
  ).toBe(false);
  expect(
    canReturnToWorkspace({ ...warm, changingHost: true, settled: false }),
  ).toBe(false);
});

test("showsPhoneHostSetup gates unconfigured phone hosts and resets when host changes", () => {
  const unconfigured = {
    phone: true,
    startPage: "chat",
    hostOpen: true,
    providersLoaded: true,
    agentsLoaded: true,
    agentCount: 0,
    hasGroupConversation: false,
    hostOrigin: "https://vps-a.example",
  };

  expect(showsPhoneHostSetup(unconfigured)).toBe(true);
  expect(showsPhoneHostSetup({ ...unconfigured, phone: false })).toBe(false);
  expect(showsPhoneHostSetup({ ...unconfigured, agentCount: 1 })).toBe(false);
  expect(
    showsPhoneHostSetup({ ...unconfigured, hasGroupConversation: true }),
  ).toBe(false);

  // Dismissed for the current host session: user can configure directly on the phone.
  expect(
    showsPhoneHostSetup({
      ...unconfigured,
      dismissedForOrigin: "https://vps-a.example",
    }),
  ).toBe(false);

  // Switching to another unconfigured host resets the gate.
  expect(
    showsPhoneHostSetup({
      ...unconfigured,
      hostOrigin: "https://vps-b.example",
      dismissedForOrigin: "https://vps-a.example",
    }),
  ).toBe(true);
});
