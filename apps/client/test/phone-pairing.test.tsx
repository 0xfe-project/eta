import { expect, open, test } from "nsh/test";

test("loopback-only host hides broken QR code and enables Tailscale HTTPS in one click", async () => {
  const app = await open("./fixtures/phone-pairing.tsx", {
    width: 1440,
    height: 900,
    locale: "en-US",
    urlScheme: "eta://fixture/loopback",
  });

  await app.press("label:Connect phone");
  await app.waitFor("label:Enable Tailscale HTTPS");

  // Never render a broken 127.0.0.1 QR code in the loopback-only setup state.
  expect(app.count("label:Eta pairing code")).toBe(0);
  expect(app.texts()).toContain(
    "This host only listens locally, so a phone can't reach it yet.",
  );
  // Custom URL field is directly accessible without an error gate.
  expect(app.count("label:Phone host address")).toBe(1);

  await app.press("label:Enable Tailscale HTTPS");
  await app.waitFor("label:Eta pairing code");

  expect(app.texts()).toContain("https://mac.tail.ts.net");
  expect(app.texts()[0]).toContain(
    'machines.setTailscaleServe {"enabled":true}',
  );
  expect(app.texts()[0]).toContain(
    'machines.phoneLink {"url":"https://mac.tail.ts.net"}',
  );
});

test("port 443 occupied offers one-click retry on port 8443", async () => {
  const app = await open("./fixtures/phone-pairing.tsx", {
    width: 1440,
    height: 900,
    locale: "en-US",
    urlScheme: "eta://fixture/port-busy",
  });

  await app.press("label:Connect phone");
  await app.waitFor("label:Enable Tailscale HTTPS");
  await app.press("label:Enable Tailscale HTTPS");

  await app.waitFor("label:Scan with your phone >> label:Retry on port 8443");
  expect(app.count("label:Eta pairing code")).toBe(0);
  expect(app.texts()).toContain(
    "Port 443 is already used by another Tailscale service.",
  );

  await app.press("label:Scan with your phone >> label:Retry on port 8443");
  await app.waitFor("label:Eta pairing code");

  expect(app.texts()).toContain("https://mac.tail.ts.net:8443");
  expect(app.texts()[0]).toContain(
    'machines.setTailscaleServe {"enabled":true,"port":8443}',
  );
});

test("multi-route host auto-selects best route, switches routes, and supports custom URL", async () => {
  const app = await open("./fixtures/phone-pairing.tsx", {
    width: 1440,
    height: 900,
    locale: "en-US",
    urlScheme: "eta://fixture/multi-route",
  });

  await app.press("label:Connect phone");
  await app.waitFor("label:Eta pairing code");

  expect(app.texts()).toContain("https://mac.tail.ts.net");
  expect(app.count("label:Tailscale HTTPS")).toBeGreaterThan(0);
  expect(app.count("label:LAN")).toBe(1);
  expect(app.count("label:Custom URL")).toBe(1);

  // Switch to LAN route
  await app.press("label:LAN");
  await app.waitFor("text:http://192.168.1.10:8787");
  expect(app.texts()[0]).toContain(
    'machines.phoneLink {"url":"http://192.168.1.10:8787"}',
  );

  // Switch to Custom URL: reject loopback, then accept reachable URL
  await app.press("label:Custom URL");
  await app.type("label:Phone host address", "http://127.0.0.1:8787");
  await app.press("label:Generate code");
  await app.waitFor("text:A phone can't reach a local loopback address.");

  await app.clear("label:Phone host address");
  await app.type("label:Phone host address", "https://eta.example.com");
  await app.press("label:Generate code");
  await app.waitFor("text:https://eta.example.com");
  expect(app.texts()[0]).toContain(
    'machines.phoneLink {"url":"https://eta.example.com"}',
  );
});

test("Settings › Machines exposes Tailscale HTTPS status and toggle", async () => {
  const app = await open("./fixtures/phone-pairing.tsx", {
    width: 1440,
    height: 900,
    locale: "en-US",
    urlScheme: "eta://fixture/loopback",
  });

  await app.waitFor("label:Tailscale HTTPS");
  await app.press("label:Tailscale HTTPS");
  await app.waitFor("text:https://mac.tail.ts.net");
  expect(app.texts()[0]).toContain(
    'machines.setTailscaleServe {"enabled":true}',
  );

  await app.press("label:Tailscale HTTPS");
  await app.waitFor(
    'text:machines.addresses {}\nmachines.setTailscaleServe {"enabled":true}\nmachines.setTailscaleServe {"enabled":false}',
  );
});

test("Chinese locale renders concise zh copy in setup and port-occupied retry", async () => {
  const app = await open("./fixtures/phone-pairing.tsx", {
    width: 390,
    height: 844,
    locale: "zh-CN",
    urlScheme: "eta://fixture/port-busy",
  });

  await app.press("label:连接手机");
  await app.waitFor("label:开启 Tailscale HTTPS");
  expect(app.count("label:Eta 配对码")).toBe(0);
  expect(app.texts()).toContain("当前主机仅监听本机地址，手机还无法直接连接。");

  await app.press("label:开启 Tailscale HTTPS");
  await app.waitFor("label:改用端口 8443 重试");
  expect(app.texts()).toContain("端口 443 已被其他 Tailscale 服务占用。");
});

test("probe-failed after rollback keeps toggle OFF, passes 90s RPC timeout, and never claims started in EN", async () => {
  const app = await open("./fixtures/phone-pairing.tsx", {
    width: 1440,
    height: 900,
    locale: "en-US",
    urlScheme: "eta://fixture/probe-failed",
  });

  await app.waitFor("label:Tailscale HTTPS");
  await app.press("label:Tailscale HTTPS");
  await app.waitFor("id:tailscale-https-error");

  expect(app.texts()).toContain("timeoutMs=90000");
  expect(app.count("label:Turn off")).toBe(0);
  const joined = app.texts().join("\n");
  expect(joined).toContain(
    "Tailscale HTTPS is not active: HTTPS verification on port 443 failed, so Tailscale Serve was rolled back.",
  );
  expect(joined.toLowerCase()).not.toContain("tailscale https started");

  // Toggle remained OFF, so pressing it again sends enabled:true (and succeeds on retry).
  await app.press("label:Tailscale HTTPS");
  await app.waitFor("id:tailscale-https-error", { state: "gone" });
  expect(app.texts()[0]).toBe(
    'machines.addresses {}\nmachines.setTailscaleServe {"enabled":true}\nmachines.setTailscaleServe {"enabled":true}',
  );
});

test("probe-failed after rollback renders rolled-back ZH copy without 已启动", async () => {
  const app = await open("./fixtures/phone-pairing.tsx", {
    width: 390,
    height: 844,
    locale: "zh-CN",
    urlScheme: "eta://fixture/probe-failed",
  });

  await app.press("label:连接手机");
  await app.waitFor("label:开启 Tailscale HTTPS");
  await app.press("label:开启 Tailscale HTTPS");
  await app.waitFor("text:/Tailscale Serve 已回滚/");

  const joined = app.texts().join("\n");
  expect(joined).toContain("Tailscale HTTPS 未开启");
  expect(joined).toContain(
    "端口 443 的 HTTPS 验证未通过，Tailscale Serve 已回滚",
  );
  expect(joined).not.toContain("已启动");
  expect(app.count("label:关闭 Tailscale HTTPS")).toBe(0);
});

test("probe-failed when holderStatus is ours reports active Serve and offers Turn off in Machines and PhonePairing", async () => {
  const app = await open("./fixtures/phone-pairing.tsx", {
    width: 1440,
    height: 900,
    locale: "en-US",
    urlScheme: "eta://fixture/probe-failed-ours",
  });

  await app.waitFor("label:Tailscale HTTPS");
  await app.press("label:Tailscale HTTPS");
  await app.waitFor("label:Turn off");

  expect(app.texts().join("\n")).toContain(
    "Tailscale Serve is still active on port 443, but HTTPS verification failed",
  );

  // Also exposed in PhonePairing popover, where Turn off Tailscale HTTPS disables it cleanly.
  await app.press("label:Connect phone");
  await app.waitFor("label:Turn off Tailscale HTTPS");
  expect(app.texts().join("\n")).toContain(
    "Tailscale Serve is still active on port 443, but HTTPS verification failed",
  );

  await app.press("label:Turn off Tailscale HTTPS");
  await app.waitFor("label:Turn off Tailscale HTTPS", { state: "gone" });
  expect(app.texts()[0]).toContain(
    'machines.setTailscaleServe {"enabled":false}',
  );
  await app.press("label:Close");
  await app.waitFor("id:tailscale-https-error", { state: "gone" });
});
