/**
 * The slash menu of a conversation's input in the whole interface, on a real host: every command
 * reachable with ↓, and the menu fitting the screen's height.
 */
import { describe, expect, it } from "vitest";
import { extensions } from "../../src/extensions.gen";
import { KEYS, plain } from "../ui-support/render";
import { quietGroup, screenShows, WITHOUT_SETUP } from "./view-host-world";

/** The commands of the interface the world shows, in the order a lone `/` lists them. */
function commandNames(): string[] {
  return extensions
    .filter((extension) => !WITHOUT_SETUP.includes(extension.id))
    .flatMap((extension) => extension.commands ?? [])
    .map((command) => command.name)
    .sort();
}

/** The lines under the input's lower rule, down to the status line and the tab bar. */
function underInput(screen: string): string[] {
  const all = screen.split("\n").map((line) => line.trimEnd());
  const input = all.findIndex(
    (line, i) => line.startsWith("› /") && /^─+$/.test(all[i - 1] ?? ""),
  );
  return all.slice(input + 2, -2);
}

describe("the slash menu in a conversation", () => {
  it("lists eight rows after a lone / and goes down to the last command", async () => {
    const names = commandNames();
    const world = await quietGroup();
    const r = await world.showConversation(world.group.id, {
      columns: 80,
      rows: 24,
    });
    await screenShows(r, "Write a message");
    await r.type("/");
    await screenShows(r, `/${names[0]}`);
    let menu = underInput(plain(r)).filter((line) => line !== "");
    expect(menu).toHaveLength(8);
    expect(menu[0]?.startsWith(`› /${names[0]} `)).toBe(true);
    expect(menu[7]).toBe(`↓ ${names.length - 7} more`);
    for (let i = 1; i < names.length; i++) await r.press(KEYS.down);
    menu = underInput(plain(r)).filter((line) => line !== "");
    expect(menu).toHaveLength(8);
    expect(menu[0]).toBe(`↑ ${names.length - 7} more`);
    expect(menu[7]?.startsWith(`› /${names.at(-1)} `)).toBe(true);
  }, 60_000);

  it("shrinks to the rows a short screen leaves under the input, the selection in view", async () => {
    const names = commandNames();
    const world = await quietGroup();
    // Eight rows for the view: the input takes three, the menu the other five.
    const r = await world.showConversation(world.group.id, {
      columns: 80,
      rows: 10,
    });
    await screenShows(r, "Write a message");
    await r.type("/");
    await screenShows(r, `/${names[0]}`);
    let all = plain(r).split("\n");
    expect(all).toHaveLength(10);
    let menu = underInput(plain(r));
    expect(menu).toHaveLength(5);
    expect(menu[0]?.startsWith(`› /${names[0]} `)).toBe(true);
    expect(menu[4]).toBe(`↓ ${names.length - 4} more`);
    for (let i = 1; i < names.length; i++) await r.press(KEYS.down);
    all = plain(r).split("\n");
    expect(all).toHaveLength(10);
    expect(all.some((line) => line.startsWith("› /"))).toBe(true);
    menu = underInput(plain(r));
    expect(menu).toHaveLength(5);
    expect(menu[4]?.startsWith(`› /${names.at(-1)} `)).toBe(true);
    await r.press(KEYS.tab);
    // Tab writes the name and a space, and the menu closes after the space.
    await screenShows(r, (screen) =>
      screen.split("\n").includes(`› /${names.at(-1)}`),
    );
    expect(plain(r)).not.toContain("more");
  }, 60_000);
});
