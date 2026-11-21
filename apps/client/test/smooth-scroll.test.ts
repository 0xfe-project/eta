import { expect, test } from "nsh/test";
import { smoothScrollProps } from "../src/components/smooth-scroll";

function fakeGlide() {
  const calls: string[] = [];
  return {
    calls,
    glide: {
      ref: (_node: never) => calls.push("ref"),
      onWheel: (_event: never) => calls.push("wheel"),
      onScroll: (_event: never) => calls.push("scroll"),
      scrollEventThrottle: 16,
    },
  };
}

test("off Windows a smooth scroll adds nothing to Scroll", () => {
  expect(smoothScrollProps({ style: { flexGrow: 1 } }, {})).toBeUndefined();
});

test("on Windows the wheel goes to a view inside, never to the Scroll", () => {
  const { glide } = fakeGlide();
  const added = smoothScrollProps({}, glide as never)!;
  expect(typeof added.onWheel).toBe("function");
  expect(typeof added.scroll.onScroll).toBe("function");
  expect(typeof added.scroll.ref).toBe("function");
  expect(added.scroll.scrollEventThrottle).toBe(16);
  expect(added.scroll.onWheel).toBeUndefined();
});

test("the glide runs first, then the handlers and ref the caller gave", () => {
  const { glide, calls } = fakeGlide();
  const props = {
    ref: () => calls.push("own ref"),
    onWheel: () => calls.push("own wheel"),
    onScroll: () => calls.push("own scroll"),
  };
  const added = smoothScrollProps(props as never, glide as never)!;
  const scroll = added.scroll as Record<string, (event?: unknown) => void>;
  scroll.ref!({});
  added.onWheel({} as never);
  scroll.onScroll!({});
  expect(calls).toEqual([
    "ref",
    "own ref",
    "wheel",
    "own wheel",
    "scroll",
    "own scroll",
  ]);
});

test("without handlers of its own it still glides", () => {
  const { glide, calls } = fakeGlide();
  const added = smoothScrollProps({}, glide as never)!;
  added.onWheel({} as never);
  (added.scroll.onScroll as (event?: unknown) => void)({});
  expect(calls).toEqual(["wheel", "scroll"]);
});
