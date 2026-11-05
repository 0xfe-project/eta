import { expect, open, test } from "nsh/test";
import { parseConnectLink } from "./link";

const DEV = "../../../DevApp.tsx";
const form = (extra: Record<string, string> = {}) =>
  open(DEV, { storage: { "eta.language": "zh", ...extra } });

test("parseConnectLink reads the host's link and nothing else", () => {
  expect(
    parseConnectLink(
      "eta://connect?address=https%3A%2F%2Fmac-studio.ts.net&token=a%2Bb",
    ),
  ).toEqual({
    address: "https://mac-studio.ts.net",
    token: "a+b",
  });
  expect(parseConnectLink("  eta://connect?address=mac-studio  ")).toEqual({
    address: "mac-studio",
    token: "",
  });
  expect(parseConnectLink("eta://connect?token=x")).toBeUndefined();
  expect(parseConnectLink("mac-studio.ts.net")).toBeUndefined();
});

test("08: connecting with an address opens the app", async () => {
  const app = await form();
  await app.waitFor("连一次主机，所有机器都在。");
  await app.press("连接");
  expect(app.texts()).toContain(
    "手机只是一块屏。智能体、记忆和对话都留在你的机器上。",
  );
  await app.type("id:connect-address", "mac-studio.tail3f2a.ts.net");
  await app.type("id:connect-token", "secret");
  await app.press("连接");
  await app.waitFor("id:tab-inbox");
  expect(JSON.parse(app.storage()["eta.host"] ?? "{}")).toEqual({
    address: "mac-studio.tail3f2a.ts.net",
    token: "secret",
  });
});

test("a pasted link fills the form", async () => {
  const app = await form();
  await app.waitFor("id:connect-address");
  await app.paste("id:connect-address", {
    text: "eta://connect?address=mac-studio.tail3f2a.ts.net&token=secret",
  });
  await app.waitUntil(() => app.value("id:connect-token") === "secret");
  expect(app.value("id:connect-address")).toBe("mac-studio.tail3f2a.ts.net");
});

test("the scan button says it can't yet", async () => {
  const app = await form();
  await app.waitFor("扫电脑上的二维码");
  await app.press("扫电脑上的二维码");
  await app.waitFor("这台设备不能扫码，请粘贴连接链接或手动填写。");
});

for (const [refuse, message] of [
  ["token", "令牌不对。"],
  ["network", "网络连接失败。"],
  ["timeout", "宿主没有及时回应。"],
]) {
  test(`08a: ${refuse}`, async () => {
    const app = await form({ "eta.fake.refuse": refuse as string });
    await app.waitFor("id:connect-address");
    await app.type("id:connect-address", "mac-studio.tail3f2a.ts.net");
    await app.press("连接");
    await app.waitFor("连不上这台主机");
    expect(app.texts()).toContain(message as string);
    expect(app.texts()).toContain("重试");
    expect(app.texts()).not.toContain("扫电脑上的二维码");
    expect(app.value("id:connect-address")).toBe("mac-studio.tail3f2a.ts.net");
  });
}

test("08b′: it gives up after a while, keeps the host, and can change it", async () => {
  const app = await open(DEV, {
    clock: {},
    storage: {
      "eta.language": "zh",
      "eta.host": JSON.stringify({
        address: "mac-studio.tail3f2a.ts.net",
        token: "secret",
      }),
      "eta.fake.scenario": "drop",
    },
  });
  await app.waitFor("id:tab-inbox");
  await app.waitFor("与宿主的连接已断开。", { timeout: 40_000 });
  expect(app.texts()).toContain("智能体还在主机上继续运行。");
  expect(
    app
      .texts()
      .some((text) =>
        text.startsWith("mac-studio.tail3f2a.ts.net · 上次在线 "),
      ),
  ).toBe(true);
  await app.press("换一台主机");
  await app.waitFor("连一次主机，所有机器都在。");
  expect(app.storage()["eta.host"]).toBeUndefined();
  expect(app.value("id:connect-token")).toBe("");
});

test("08c: the steps follow the host, and the app comes in by itself", async () => {
  const app = await open(DEV, {
    storage: {
      "eta.language": "zh",
      "eta.host": JSON.stringify({ address: "fake", token: "" }),
      "eta.fake.scenario": "uninitialized",
      "eta.fake.live": "1",
    },
  });
  await app.waitFor("mac-studio 还没准备好");
  expect(app.texts()).toContain("还差两步，在电脑上打开 Eta 完成。");
  expect(app.texts()).toContain("还没有 provider。加一个，宿主才有东西可跑。");
  await app.waitFor("还差一步，在电脑上打开 Eta 完成。", { timeout: 10_000 });
  expect(app.texts()).toContain("已经绑定了模型。");
  await app.waitFor("id:tab-inbox", { timeout: 10_000 });
});
