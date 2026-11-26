import { expect, open, test } from "nsh/test";

// The agent editor's thinking level offers what the agent's model declares (#799), over the
// scripted host of fixtures/thinking.tsx.

const editor = (agent: string) =>
  open("./fixtures/thinking.tsx", {
    width: 1440,
    height: 900,
    locale: "en-US",
    urlScheme: `eta://fixture/${agent}`,
  });

/** The levels the thinking menu offers, after its "Model default". */
async function offered(app: Awaited<ReturnType<typeof editor>>) {
  await app.press("label:Thinking level");
  const levels = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ].filter((level) => app.count(`label:${level}`) > 0);
  expect(app.count("label:Model default")).toBeGreaterThan(0);
  return levels;
}

test("a model that declares high and max offers only those", async () => {
  const app = await editor("flash");
  expect(await offered(app)).toEqual(["high", "max"]);
});

test("a model that declares none offers off", async () => {
  const app = await editor("hy");
  expect(await offered(app)).toEqual(["off", "high"]);
});

test("a model that does not reason offers only off", async () => {
  const app = await editor("plain");
  expect(await offered(app)).toEqual(["off"]);
});

test("a model whose levels are not known offers the five and says so", async () => {
  const app = await editor("thinks");
  expect(app.texts()).toContain(
    "This model's levels are not known; the one you pick is sent as it is.",
  );
  expect(await offered(app)).toEqual([
    "off",
    "minimal",
    "low",
    "medium",
    "high",
  ]);
});

test("a model that says nothing about thinking offers off and says why", async () => {
  const app = await editor("silent");
  expect(app.texts().join("\n")).toContain(
    "This model declares no thinking levels, so eta sends none.",
  );
  expect(await offered(app)).toEqual(["off"]);
});

test("ultra is offered only where the runtime lists it", async () => {
  const app = await editor("cody");
  await app.waitFor("text:Sonnet");
  expect(await offered(app)).toEqual(["low", "medium", "high", "ultra"]);
});

test("a saved level the model does not take is shown and flagged", async () => {
  const app = await editor("stale");
  expect(app.texts()).toContain(
    "This model does not take ultra; it runs on the model's default.",
  );
  expect(await offered(app)).toEqual(["high", "max"]);
});

test("a new model that does not take the level clears it and says so", async () => {
  const app = await editor("hy");
  // high is one Flash takes: kept, nothing said.
  await app.press("label:Model");
  await app.press("label:Flash");
  expect(app.texts().join("\n")).not.toContain("set back to");
  // Plain takes only off: high goes, and the editor says so before anything is saved.
  await app.press("label:Model");
  await app.press("label:Plain");
  expect(app.texts()).toContain(
    "The new model does not take high; set back to the model's default.",
  );
  await app.press("label:Save");
  await app.waitFor(
    'text:agents.update {"agentId":"hy","model":"proxy:plain","thinkingLevel":null}',
  );
});

test("the model field is the form's own width, as the thinking level's is", async () => {
  const app = await editor("flash");
  // The model row is an ordinary row of the form: the same column the runtime and the thinking
  // level get, not one longer of its own (it used to be 256 next to their 160).
  const runtime = app.layout("label:Runtime")!;
  const model = app.layout("label:Model")!;
  const thinking = app.layout("label:Thinking level")!;
  expect(model.width).toBe(runtime.width);
  expect(model.width).toBe(thinking.width);
  expect(model.x).toBe(thinking.x);
  // The menu the field opens is not held to the field's width: a long model name and id read
  // in full there.
  await app.press("label:Model");
  expect(app.layout("label:Flash")!.width).toBeGreaterThan(model.width);
});
