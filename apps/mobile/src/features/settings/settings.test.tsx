import { expect, open, test } from "nsh/test";

const ADDRESS = "mac-studio.tail3f2a.ts.net";
const start = async (
  scenario = "",
  network?: Parameters<typeof open>[1] extends infer O
    ? O extends { network?: infer N }
      ? N
      : never
    : never,
) => {
  const app = await open("../../../DevApp.tsx", {
    ...(network === undefined ? {} : { network }),
    storage: {
      "eta.host": JSON.stringify({ address: ADDRESS, token: "secret" }),
      "eta.language": "zh",
      "eta.fake.scenario": scenario,
    },
  });
  await app.waitFor("id:machines-online");
  await app.press("id:machines-online");
  await app.waitFor("mac-studio");
  await app.press("外观");
  await app.waitFor("颜色模式");
  return app;
};

test("10: the color mode and the language stick, and redraw", async () => {
  const app = await start();
  await app.press("深色");
  await app.waitUntil(() => app.storage()["eta.scheme"] === "dark");
  await app.press("English");
  await app.waitFor("Color mode");
  expect(app.storage()["eta.language"]).toBe("en");
  expect(app.texts()).toContain("Settings");
  await app.press("简体中文");
  await app.waitFor("颜色模式");
});

test("10b: each machine as it stands, and no way to change it", async () => {
  const app = await start("machines");
  await app.press("label:机器");
  await app.waitFor("5 个运行");
  await app.waitFor("3/4");
  const texts = app.texts();
  expect(texts).toContain("主机器 · 版本 0.8.2 · 这台手机连着它");
  expect(texts).toContain("版本 0.8.0 · 需要更新");
  expect(texts).toContain("1/2");
  expect(texts).toContain("1/4");
  expect(texts).toContain("离线 · 上次在线 6 小时前 · 1 个任务在等");
  expect(texts).toContain("待批准");
});

test("10a: a machine and what runs on it", async () => {
  const app = await start("machines");
  await app.press("label:机器");
  await app.waitFor("mb-air");
  await app.press("mb-air");
  await app.waitFor("同时运行");
  await app.waitFor("1 / 2");
  await app.waitFor("运行中 1");
  const texts = app.texts();
  expect(texts).toContain("在线");
  expect(texts).toContain("macOS");
  expect(texts).toContain("0.8.0 · 需要更新");
  expect(texts).toContain("Mori · #204 官网改版");
  expect(texts).toContain("工作中 · 10 分钟");
});

test("10c: what it is connected to, and leaving it", async () => {
  const app = await start();
  await app.press("label:连接");
  await app.waitFor("已连接");
  await app.waitFor("0.8.2");
  expect(app.texts()).toContain("mac-studio");
  expect(app.texts()).toContain(ADDRESS);
  await app.press("断开连接");
  await app.waitFor("连一次主机，所有机器都在。");
  expect(app.storage()["eta.host"]).toBeUndefined();
  expect(app.value("id:connect-address")).toBe(ADDRESS);
  await app.type("id:connect-token", "secret");
  await app.press("连接");
  await app.waitFor("id:tab-inbox");
  expect(app.texts()).not.toContain("断开连接");
});

test("10c: the version comes from GET /version with the token", async () => {
  const app = await start("real-version", {
    "GET http://mac-studio.tail3f2a.ts.net/version": {
      status: 200,
      body: "mh3k2x\n",
    },
  });
  await app.press("label:连接");
  await app.waitFor("mh3k2x");
  const request = app.requests().find((one) => one.url.endsWith("/version"));
  expect(
    request?.headers?.["x-eta-token"] ?? request?.headers?.["X-Eta-Token"],
  ).toBe("secret");
});

test("10c: a host without /version shows a dash, not an error", async () => {
  const app = await start("real-version", {
    "GET http://mac-studio.tail3f2a.ts.net/version": { status: 404, body: "" },
  });
  await app.press("label:连接");
  await app.waitFor("—");
});
