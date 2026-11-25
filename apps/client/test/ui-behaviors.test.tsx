import { expect, open, test } from "nsh/test";

test("createPressable guards disabled and busy presses", async () => {
  const app = await open("./fixtures/ui-behaviors.tsx", {
    width: 800,
    height: 600,
  });
  expect(app.shows("text:press:0")).toBe(true);
  await app.press("id:pressable");
  expect(app.shows("text:press:1")).toBe(true);

  await app.press("text:Toggle disabled");
  await app.press("id:pressable");
  expect(app.shows("text:press:1")).toBe(true);
  await app.press("text:Toggle disabled");

  await app.press("text:Toggle busy");
  await app.press("id:pressable");
  expect(app.shows("text:press:1")).toBe(true);
  await app.press("text:Toggle busy");

  await app.press("id:pressable");
  expect(app.shows("text:press:2")).toBe(true);
});

test("createDismissable dismisses LIFO and blocks lower layers when top is non-dismissable", async () => {
  const app = await open("./fixtures/ui-behaviors.tsx", {
    width: 800,
    height: 600,
  });
  expect(app.shows("text:stack:2 log:")).toBe(true);

  await app.press("text:Toggle top enabled");
  await app.press("text:Dismiss top");
  expect(app.shows("text:stack:2 log:")).toBe(true);

  await app.press("text:Toggle top enabled");
  await app.press("text:Dismiss top");
  expect(app.shows("text:stack:1 log:second")).toBe(true);

  await app.press("text:Dismiss top");
  expect(app.shows("text:stack:1 log:second,first")).toBe(true);
});

test("createRovingFocus skips disabled items and pairs with createTypeahead", async () => {
  const app = await open("./fixtures/ui-behaviors.tsx", {
    width: 800,
    height: 600,
  });
  expect(app.shows("text:active:alpha match:")).toBe(true);
  await app.press("text:Rove right");
  expect(app.shows("text:active:gamma match:")).toBe(true);
  await app.press("text:Rove end");
  expect(app.shows("text:active:delta match:")).toBe(true);
  await app.press("text:Rove right");
  expect(app.shows("text:active:alpha match:")).toBe(true);
  await app.press("text:Type d");
  expect(app.shows("text:active:delta match:delta")).toBe(true);
});

test("createSelection, createAdjustable, and definePrimitive + createDisclosure work together", async () => {
  const app = await open("./fixtures/ui-behaviors.tsx", {
    width: 800,
    height: 600,
  });
  expect(app.shows("text:sel:alpha")).toBe(true);
  await app.press("text:Toggle gamma");
  expect(app.shows("text:sel:alpha,gamma")).toBe(true);
  await app.press("text:Clear selection");
  expect(app.shows("text:sel:")).toBe(true);

  expect(app.shows("text:width:300")).toBe(true);
  await app.press("text:Step up");
  expect(app.shows("text:width:320")).toBe(true);
  await app.press("text:Large up");
  expect(app.shows("text:width:420")).toBe(true);
  await app.press("text:Adj min");
  expect(app.shows("text:width:200")).toBe(true);

  expect(app.shows("id:primitive-content")).toBe(false);
  await app.press("id:primitive-trigger");
  expect(app.shows("text:Hidden body")).toBe(true);
});
