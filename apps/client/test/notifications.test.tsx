import { expect, open, test } from "nsh/test";

const fixture = "./fixtures/notifications.tsx";

function counterValue(app: Awaited<ReturnType<typeof open>>, key: string) {
  const line = app.texts().find((t) => t.startsWith("Undo:")) ?? "";
  const match = new RegExp(`\\b${key}:(\\d+)`).exec(line);
  return match ? Number(match[1]) : -1;
}

async function assertAllNotificationsClickable(
  app: Awaited<ReturnType<typeof open>>,
  closedCounterKey: string,
  triggerPrefix?: string,
) {
  if (triggerPrefix) {
    await app.press(`label:${triggerPrefix} All`);
  }
  await app.clock!.runFor(350);

  expect(app.shows("id:toast")).toBe(true);
  expect(app.shows("id:progress-notification-job")).toBe(true);
  expect(app.shows("id:host-error-banner")).toBe(true);

  const undoBefore = counterValue(app, "Undo");
  const cancelBefore = counterValue(app, "Cancel");

  // 1. Expand & collapse Host Error details, then dismiss without closing dialog.
  await app.press("id:host-error-banner >> label:Details");
  expect(app.texts()).toContain("ECONNREFUSED 127.0.0.1:4312");
  expect(app.shows("id:host-error-banner >> label:Copy")).toBe(true);
  await app.press("id:host-error-banner >> label:Hide details");
  expect(app.texts()).not.toContain("ECONNREFUSED 127.0.0.1:4312");
  expect(app.shows("id:host-error-banner >> label:Copy")).toBe(false);
  await app.press("id:host-error-banner >> label:Dismiss error");
  expect(app.shows("id:host-error-banner")).toBe(false);
  expect(counterValue(app, closedCounterKey)).toBe(0);

  // 2. Press Toast Undo action without closing dialog.
  await app.press("id:toast >> label:Undo");
  expect(app.shows("id:toast")).toBe(false);
  expect(counterValue(app, "Undo")).toBe(undoBefore + 1);
  expect(counterValue(app, closedCounterKey)).toBe(0);

  // 3. Cancel Progress Notification without closing dialog.
  await app.press("id:progress-notification-job >> label:Cancel");
  expect(app.shows("id:progress-notification-job")).toBe(false);
  expect(counterValue(app, "Cancel")).toBe(cancelBefore + 1);
  expect(counterValue(app, closedCounterKey)).toBe(0);

  // 4. Also verify pressing a toast body itself dismisses it without closing the dialog.
  if (triggerPrefix) {
    await app.press(`label:${triggerPrefix} Toast`);
    expect(app.shows("id:toast")).toBe(true);
    await app.press("id:toast");
    expect(app.shows("id:toast")).toBe(false);
    expect(counterValue(app, closedCounterKey)).toBe(0);
  }
}

test("toast, progress, and host.error render and are clickable above non-modalFocus Modal (<Overlay>)", async () => {
  const app = await open(fixture, {
    width: 1280,
    height: 800,
    locale: "en-US",
    platform: "web",
    clock: {},
  });
  await app.press("label:Open overlay modal");
  await app.clock!.runFor(300);
  await assertAllNotificationsClickable(app, "ModalClosed", "OverlayModal");
  expect(app.shows("text:Non-modalFocus overlay dialog.")).toBe(true);
});

test("toast, progress, and host.error render and are clickable above modalFocus Modal (<Dialog>)", async () => {
  const app = await open(fixture, {
    width: 1280,
    height: 800,
    locale: "en-US",
    platform: "web",
    clock: {},
  });
  await app.press("label:Open focused modal");
  await app.clock!.runFor(300);
  await assertAllNotificationsClickable(app, "FocusedClosed", "FocusedModal");
  expect(app.shows("text:Settings")).toBe(true);
});

test("nested Modal (overlay and modalFocus) inside Settings keeps notifications above all backdrops", async () => {
  const app = await open(fixture, {
    width: 1280,
    height: 800,
    locale: "en-US",
    platform: "web",
    clock: {},
  });
  await app.press("label:Open focused modal");
  await app.clock!.runFor(300);

  // Nested overlay modal inside modalFocus modal
  await app.press("label:Open nested overlay modal");
  await app.clock!.runFor(300);
  await assertAllNotificationsClickable(
    app,
    "NestedOverlayClosed",
    "NestedOverlay",
  );
  expect(counterValue(app, "FocusedClosed")).toBe(0);

  // Close nested overlay modal and verify notifications immediately work on outer modal even mid-leave
  await app.press("label:NestedOverlay All");
  await app.clock!.runFor(350);
  await app.press("label:Close >> nth=1");
  // Leaving animation takes 180ms; ownership must already be back on Settings at 0ms.
  expect(app.shows("id:toast")).toBe(true);
  expect(app.shows("id:host-error-banner")).toBe(true);
  await app.press("id:toast >> label:Undo");
  await app.press("id:host-error-banner >> label:Dismiss error");
  await app.press("id:progress-notification-job >> label:Cancel");
  await app.clock!.runFor(250);
  expect(counterValue(app, "NestedOverlayClosed")).toBe(1);
  expect(counterValue(app, "FocusedClosed")).toBe(0);

  // Nested modalFocus modal inside modalFocus modal
  await app.press("label:Open nested focused modal");
  await app.clock!.runFor(300);
  await assertAllNotificationsClickable(
    app,
    "NestedFocusedClosed",
    "NestedFocused",
  );
  expect(counterValue(app, "FocusedClosed")).toBe(0);
});

test("direct NativeDialog surfaces (ConfigurePlugin, InviteAgents, Lightbox, HostRestartScreen) keep notifications clickable above backdrops", async () => {
  // 1. ConfigurePlugin (also invokes host.action -> host.error while open)
  const configureApp = await open(fixture, {
    width: 1280,
    height: 800,
    locale: "en-US",
    platform: "web",
    clock: {},
  });
  await configureApp.press("label:Schedule notifications");
  await configureApp.press("label:Open ConfigurePlugin");
  await configureApp.clock!.runFor(400);
  expect(configureApp.shows("text:Configure eta-docs")).toBe(true);
  await assertAllNotificationsClickable(configureApp, "ConfigureClosed");

  // Trigger host.error from inside ConfigurePlugin via Save failure
  await configureApp.press("label:Auto-sync docs");
  await configureApp.press("label:Save");
  await configureApp.clock!.runFor(50);
  expect(configureApp.shows("id:host-error-banner")).toBe(true);
  expect(
    configureApp.texts().some((t) => t.includes("Can't reach the host")),
  ).toBe(true);
  await configureApp.press("id:host-error-banner >> label:Details");
  expect(
    configureApp
      .texts()
      .some((t) => t.includes("Plugin registry unreachable (ECONNREFUSED)")),
  ).toBe(true);
  await configureApp.press("id:host-error-banner >> label:Dismiss error");
  expect(configureApp.shows("id:host-error-banner")).toBe(false);
  expect(counterValue(configureApp, "ConfigureClosed")).toBe(0);

  // 2. Tablet InviteAgents (<NativeDialog>, 900px width also verifies Toast + Progress stack cleanly without overlapping)
  const membersApp = await open(fixture, {
    width: 900,
    height: 700,
    locale: "en-US",
    platform: "web",
    clock: {},
  });
  await membersApp.press("label:Schedule notifications");
  await membersApp.press("label:Open InviteAgents");
  await membersApp.clock!.runFor(400);
  expect(membersApp.shows("text:Invite agents")).toBe(true);
  const tabletToastBox = membersApp.layout("id:toast");
  const tabletProgressBox = membersApp.layout("id:progress-notification-job");
  expect(tabletToastBox).toBeTruthy();
  expect(tabletProgressBox).toBeTruthy();
  expect(tabletToastBox!.y + tabletToastBox!.height).toBeLessThanOrEqual(
    tabletProgressBox!.y,
  );
  await assertAllNotificationsClickable(membersApp, "MembersClosed");

  // 3. Lightbox (<NativeDialog>)
  const lightboxApp = await open(fixture, {
    width: 1280,
    height: 800,
    locale: "en-US",
    platform: "web",
    clock: {},
  });
  await lightboxApp.press("label:Schedule notifications");
  await lightboxApp.press("label:Open Lightbox");
  await lightboxApp.clock!.runFor(400);
  expect(lightboxApp.shows("id:picture-stage")).toBe(true);
  await assertAllNotificationsClickable(lightboxApp, "LightboxClosed");

  // 4. HostRestartScreen (<NativeDialog> with zIndex: 500 update screen)
  const restartApp = await open(fixture, {
    width: 1280,
    height: 800,
    locale: "en-US",
    platform: "web",
    clock: {},
  });
  await restartApp.press("label:Schedule notifications");
  await restartApp.press("label:Open HostRestartScreen");
  await restartApp.clock!.runFor(400);
  expect(restartApp.shows("id:host-updating")).toBe(true);
  expect(restartApp.shows("id:toast")).toBe(true);
  expect(restartApp.shows("id:progress-notification-job")).toBe(true);
  expect(restartApp.shows("id:host-error-banner")).toBe(true);
  await restartApp.press("id:toast >> label:Undo");
  expect(counterValue(restartApp, "Undo")).toBe(1);
  await restartApp.press("id:host-error-banner >> label:Dismiss error");
  expect(restartApp.shows("id:host-error-banner")).toBe(false);
  await restartApp.press("id:progress-notification-job >> label:Cancel");
  expect(counterValue(restartApp, "Cancel")).toBe(1);
  expect(restartApp.shows("id:host-updating")).toBe(true);
});

test("opening and closing dialogs does not flicker ProgressNotification or reset reveal/slow timers", async () => {
  const app = await open(fixture, {
    width: 1280,
    height: 800,
    locale: "en-US",
    platform: "web",
    clock: {},
  });

  // Case A: revealed running progress stays visible immediately across dialog open & close and completes without dropping
  await app.press("label:Root Progress");
  await app.clock!.runFor(350);
  expect(app.shows("id:progress-notification-job")).toBe(true);

  await app.press("label:Open focused modal");
  // Immediately after opening modal (0ms elapsed), card must still be visible without 300ms re-hide flicker.
  expect(app.shows("id:progress-notification-job")).toBe(true);

  // Completing inside the modal keeps the done card (hasRevealed persisted in store).
  await app.press("label:FocusedModal Complete");
  expect(app.shows("id:progress-notification-job")).toBe(true);
  expect(app.texts()).toContain("Archive exported");
  await app.press("id:progress-notification-job");
  expect(counterValue(app, "Open")).toBe(1);

  // Close focused modal for next checks.
  await app.press("label:Close");
  await app.clock!.runFor(250);

  // Case B: mid-reveal timer does not reset 300ms delay when opening a dialog.
  // Use ConfigurePlugin (animation="none") so opening does not advance the manual clock by 240ms.
  await app.press("label:Root Progress");
  await app.clock!.runFor(200);
  expect(app.shows("id:progress-notification-job")).toBe(false);
  await app.press("label:Open ConfigurePlugin");
  expect(app.shows("id:progress-notification-job")).toBe(false);
  await app.clock!.runFor(120);
  expect(app.shows("id:progress-notification-job")).toBe(true);
  await app.press("id:progress-notification-job >> label:Cancel");
  await app.press("label:Close");

  // Case C: 10s slow timer continues across dialog open/close without resetting
  await app.press("label:Root Indeterminate");
  await app.clock!.runFor(6000);
  expect(app.texts()).not.toContain("Taking longer than usual…");
  await app.press("label:Open ConfigurePlugin");
  await app.clock!.runFor(3800);
  expect(app.texts()).not.toContain("Taking longer than usual…");
  await app.clock!.runFor(300);
  expect(app.texts()).toContain("Taking longer than usual…");
  await app.press("id:progress-notification-indet >> label:Cancel");
});

test("phone width (390px) stacks simultaneous Toast and Progress Notification with empty intersection", async () => {
  const app = await open(fixture, {
    width: 390,
    height: 844,
    locale: "en-US",
    platform: "web",
    clock: {},
  });

  const assertNoOverlap = () => {
    const toastBox = app.layout("id:toast");
    const progressBox = app.layout("id:progress-notification-job");
    expect(toastBox).toBeTruthy();
    expect(progressBox).toBeTruthy();
    expect(toastBox!.y + toastBox!.height).toBeLessThanOrEqual(progressBox!.y);
  };

  // Root phone layout
  await app.press("label:Root All");
  await app.clock!.runFor(350);
  assertNoOverlap();
  await app.press("id:toast >> label:Undo");
  await app.press("id:progress-notification-job >> label:Cancel");
  await app.press("id:host-error-banner >> label:Dismiss error");

  // Over phone sheet Modal (overPhoneNavigation: true)
  await app.press("label:Open overlay modal");
  await app.clock!.runFor(400);
  await app.press("label:OverlayModal All");
  await app.clock!.runFor(350);
  assertNoOverlap();
  await assertAllNotificationsClickable(app, "ModalClosed");
  await app.press("label:Close");
  await app.clock!.runFor(300);

  // Over non-overlay phone Modal (overPhoneNavigation: false)
  await app.press("label:Open phone inline modal");
  await app.clock!.runFor(400);
  await app.press("label:PhoneInline All");
  await app.clock!.runFor(350);
  assertNoOverlap();
  await assertAllNotificationsClickable(app, "PhoneInlineClosed");
});

test("safe-area insets are applied once, not doubled inside Modal or padded NativeDialog", async () => {
  // Phone portrait safe area: top 59, bottom 34
  const phoneApp = await open(fixture, {
    width: 393,
    height: 852,
    safeArea: { top: 59, bottom: 34 },
    locale: "en-US",
    platform: "web",
    clock: {},
  });
  await phoneApp.press("label:Root All");
  await phoneApp.clock!.runFor(350);
  const rootPhoneToast = phoneApp.layout("id:toast");
  const rootPhoneError = phoneApp.layout("id:host-error-banner");
  expect(rootPhoneToast?.y).toBe(67); // space[8] + 59
  expect(rootPhoneError!.y + rootPhoneError!.height).toBe(852 - (12 + 34));

  await phoneApp.press("label:Open overlay modal");
  await phoneApp.clock!.runFor(400);
  const modalPhoneToast = phoneApp.layout("id:toast");
  const modalPhoneError = phoneApp.layout("id:host-error-banner");
  expect(modalPhoneToast?.y).toBe(67); // Not 126 (double safe area)!
  expect(modalPhoneError!.y + modalPhoneError!.height).toBe(852 - (12 + 34));

  // Desktop/tablet safe area: top 40, bottom 20
  const deskApp = await open(fixture, {
    width: 1280,
    height: 800,
    safeArea: { top: 40, bottom: 20 },
    storage: { tabletConfigure: "1" },
    locale: "en-US",
    platform: "web",
    clock: {},
  });
  await deskApp.press("label:Root All");
  await deskApp.clock!.runFor(350);
  expect(deskApp.layout("id:toast")?.y).toBe(56); // space[16] + 40
  expect(
    deskApp.layout("id:host-error-banner")!.y +
      deskApp.layout("id:host-error-banner")!.height,
  ).toBe(800 - (16 + 20));

  await deskApp.press("label:Open overlay modal");
  await deskApp.clock!.runFor(300);
  expect(deskApp.layout("id:toast")?.y).toBe(56);
  await deskApp.press("label:Close");
  await deskApp.clock!.runFor(250);

  await deskApp.press("label:Open focused modal");
  await deskApp.clock!.runFor(300);
  expect(deskApp.layout("id:toast")?.y).toBe(56);
  await deskApp.press("label:Close");
  await deskApp.clock!.runFor(250);

  // Tablet ConfigurePlugin applies paddingTop: sizes.header + space[16] (56) on NativeDialog;
  // NotificationHost <Overlay> must stay at top: space[16] + 40 = 56, not offset by dialog padding.
  await deskApp.press("label:Open ConfigurePlugin");
  await deskApp.clock!.runFor(300);
  expect(deskApp.layout("id:toast")?.y).toBe(56);
});

test("initially mounted NativeDialog keeps NotificationHost priority over later-mounted root NotificationHost", async () => {
  const app = await open(fixture, {
    width: 1280,
    height: 800,
    locale: "en-US",
    platform: "web",
    storage: { scene: "desktop-scene", theme: "light" },
    clock: {},
  });
  await app.clock!.runFor(1400);
  expect(app.shows("text:Settings")).toBe(true);
  await app.press("id:host-error-banner >> label:Details");
  expect(
    app
      .texts()
      .some((t) =>
        t.includes("dial tcp 10.0.4.12:4312: connect: connection refused"),
      ),
  ).toBe(true);
  expect(app.shows("text:Settings")).toBe(true);
  await app.press("id:toast >> label:Undo");
  expect(app.shows("id:toast")).toBe(false);
  expect(app.shows("text:Settings")).toBe(true);
});

test("toast status dot vertically centers on the title's first line across desktop, tablet, and phone", async () => {
  const viewports = [
    { width: 1280, height: 800 },
    { width: 900, height: 700 },
    { width: 390, height: 844 },
  ] as const;

  const wrappingTitle =
    "Copied workspace diagnostics bundle and recent session logs to the system clipboard for bug reporting";

  for (const viewport of viewports) {
    const app = await open(fixture, {
      ...viewport,
      locale: "en-US",
      platform: "web",
      clock: {},
    });

    // 1. Title-only toast: dot center matches title center within 1px.
    await app.press("label:Root Title-only Toast");
    expect(app.shows("id:toast")).toBe(true);
    const titleOnlyDot = app.layout("id:toast-dot");
    const titleOnlyLabel = app.layout("text:Copied to clipboard");
    expect(titleOnlyDot).toBeTruthy();
    expect(titleOnlyLabel).toBeTruthy();
    expect(
      Math.abs(
        titleOnlyDot!.y +
          titleOnlyDot!.height / 2 -
          (titleOnlyLabel!.y + titleOnlyLabel!.height / 2),
      ),
    ).toBeLessThanOrEqual(1);
    const singleLineHeight = titleOnlyLabel!.height;
    await app.press("id:toast");
    expect(app.shows("id:toast")).toBe(false);

    // 2. Title + body toast: dot aligns with the single-line title center,
    // not hanging at the bottom of the title line and not centered over title + body.
    await app.press("label:Root Toast");
    expect(app.shows("id:toast")).toBe(true);
    const bodyToastDot = app.layout("id:toast-dot");
    const bodyToastTitle = app.layout("text:Archived task");
    const bodyToastBody = app.layout("text:Moved to archive");
    expect(bodyToastDot).toBeTruthy();
    expect(bodyToastTitle).toBeTruthy();
    expect(bodyToastBody).toBeTruthy();
    expect(bodyToastBody!.y).toBeGreaterThanOrEqual(
      bodyToastTitle!.y + bodyToastTitle!.height,
    );
    const bodyDotCenter = bodyToastDot!.y + bodyToastDot!.height / 2;
    const bodyTitleCenter = bodyToastTitle!.y + bodyToastTitle!.height / 2;
    const combinedCenter =
      (bodyToastTitle!.y + bodyToastBody!.y + bodyToastBody!.height) / 2;
    expect(Math.abs(bodyDotCenter - bodyTitleCenter)).toBeLessThanOrEqual(1);
    expect(bodyToastDot!.y + bodyToastDot!.height).toBeLessThan(
      bodyToastTitle!.y + bodyToastTitle!.height,
    );
    expect(bodyDotCenter).toBeLessThan(combinedCenter);
    await app.press("id:toast");
    expect(app.shows("id:toast")).toBe(false);

    // 3. Multi-line wrapping title toast: dot stays centered on the first line.
    await app.press("label:Root Wrapping Toast");
    expect(app.shows("id:toast")).toBe(true);
    const wrappedDot = app.layout("id:toast-dot");
    const wrappedTitle = app.layout(`text:${wrappingTitle}`);
    expect(wrappedDot).toBeTruthy();
    expect(wrappedTitle).toBeTruthy();
    expect(wrappedTitle!.height).toBeGreaterThan(singleLineHeight * 1.5);
    const wrappedDotCenter = wrappedDot!.y + wrappedDot!.height / 2;
    const firstLineCenter = wrappedTitle!.y + singleLineHeight / 2;
    expect(Math.abs(wrappedDotCenter - firstLineCenter)).toBeLessThanOrEqual(1);
    expect(wrappedDotCenter).toBeLessThan(
      wrappedTitle!.y + wrappedTitle!.height / 2,
    );
    await app.press("id:toast");
    expect(app.shows("id:toast")).toBe(false);
  }
});
