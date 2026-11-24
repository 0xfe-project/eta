import { expect, test } from "nsh/test";
import { createLanguagePreference } from "../src/i18n";
import {
  clockDistance,
  runAgo,
  timeZones,
} from "../src/pages/routines/schedule";

// The native runtime has no `Intl.RelativeTimeFormat` or `Intl.supportedValuesOf`. A routines page
// that calls them throws while it renders, and the host's read loop reads that as a lost
// connection. These tests take both away and expect the page's time words to still come out.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const language = createLanguagePreference();

/** Runs body with `Intl[name]` removed, as in the native runtime, and puts it back after. */
function without<T>(name: string, body: () => T): T {
  const original = Reflect.get(Intl, name);
  Reflect.set(Intl, name, undefined);
  try {
    return body();
  } finally {
    Reflect.set(Intl, name, original);
  }
}

const future = (offset: number) =>
  without("RelativeTimeFormat", () => clockDistance(Date.now() + offset));
const past = (offset: number) =>
  without("RelativeTimeFormat", () => runAgo(Date.now() - offset));

test("a time ahead reads in English minutes, hours and days, in the singular for one", () => {
  language.set("en");
  expect(future(30_000)).toBe("this minute");
  expect(future(MINUTE + 30_000)).toBe("in 1 minute");
  expect(future(5 * MINUTE + 30_000)).toBe("in 5 minutes");
  expect(future(HOUR + 30_000)).toBe("in 1 hour");
  expect(future(2 * HOUR + 30_000)).toBe("in 2 hours");
  expect(future(DAY + 30_000)).toBe("in 1 day");
  expect(future(3 * DAY + 30_000)).toBe("in 3 days");
});

test("a time ahead reads in Chinese minutes, hours and days", () => {
  language.set("zh");
  expect(future(30_000)).toBe("此刻");
  expect(future(MINUTE + 30_000)).toBe("1 分钟后");
  expect(future(5 * MINUTE + 30_000)).toBe("5 分钟后");
  expect(future(HOUR + 30_000)).toBe("1 小时后");
  expect(future(2 * HOUR + 30_000)).toBe("2 小时后");
  expect(future(DAY + 30_000)).toBe("1 天后");
  expect(future(3 * DAY + 30_000)).toBe("3 天后");
});

test("a time behind reads in English minutes, hours and days, in the singular for one", () => {
  language.set("en");
  expect(past(30_000)).toBe("this minute");
  expect(past(MINUTE + 30_000)).toBe("1 minute ago");
  expect(past(5 * MINUTE + 30_000)).toBe("5 minutes ago");
  expect(past(HOUR + 30_000)).toBe("1 hour ago");
  expect(past(2 * HOUR + 30_000)).toBe("2 hours ago");
  expect(past(DAY + 30_000)).toBe("1 day ago");
  expect(past(3 * DAY + 30_000)).toBe("3 days ago");
});

test("a time behind reads in Chinese minutes, hours and days", () => {
  language.set("zh");
  expect(past(30_000)).toBe("此刻");
  expect(past(MINUTE + 30_000)).toBe("1 分钟前");
  expect(past(5 * MINUTE + 30_000)).toBe("5 分钟前");
  expect(past(HOUR + 30_000)).toBe("1 小时前");
  expect(past(2 * HOUR + 30_000)).toBe("2 小时前");
  expect(past(DAY + 30_000)).toBe("1 天前");
  expect(past(3 * DAY + 30_000)).toBe("3 天前");
});

test("a time already gone reads as this minute, not a negative one", () => {
  language.set("en");
  expect(future(-5 * MINUTE)).toBe("this minute");
  expect(past(-5 * MINUTE)).toBe("this minute");
});

test("the time zone list falls back to the routine's own zone without Intl.supportedValuesOf", () => {
  expect(
    without("supportedValuesOf", () => timeZones("Asia/Shanghai")),
  ).toEqual(["Asia/Shanghai"]);
});

test("the time zone list keeps the routine's zone in front when the runtime does not list it", () => {
  const zones = timeZones("Mars/Olympus");
  expect(zones[0]).toBe("Mars/Olympus");
  if (typeof Intl.supportedValuesOf === "function")
    expect(zones.length).toBe(Intl.supportedValuesOf("timeZone").length + 1);
});
