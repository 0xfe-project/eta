/**
 * Turning the terminal's mouse reporting on and off: it follows the `mouse` setting, it is off
 * while a program has the terminal, and once eta ends it stays off.
 */
import { describe, expect, it } from "vitest";
import {
  createMouseReporting,
  MOUSE_REPORTING_OFF,
  MOUSE_REPORTING_ON,
} from "../../src/ui/mouse/reporting";

const ON = "on";
const OFF = "off";

function setup() {
  const log: string[] = [];
  const reporting = createMouseReporting((text) => {
    if (text === MOUSE_REPORTING_ON) log.push(ON);
    else if (text === MOUSE_REPORTING_OFF) log.push(OFF);
    else log.push(`other:${JSON.stringify(text)}`);
  });
  return { log, reporting };
}

describe("the sequences", () => {
  it("turn on basic reporting with SGR coordinates, and turn both off", () => {
    expect(MOUSE_REPORTING_ON).toBe("\u001B[?1000h\u001B[?1006h");
    expect(MOUSE_REPORTING_OFF).toBe("\u001B[?1006l\u001B[?1000l");
  });
});

describe("handing the terminal to a program", () => {
  it("turns on again when the program fails, and passes the failure on", async () => {
    const { log, reporting } = setup();
    reporting.setEnabled(true);
    await expect(
      reporting.handOver(async () => {
        log.push("program");
        throw new Error("no such editor");
      }),
    ).rejects.toThrow("no such editor");
    expect(log).toEqual([ON, OFF, "program", ON]);
  });
});

describe("releasing the terminal at the end", () => {
  it("stays off whatever comes after", async () => {
    const { log, reporting } = setup();
    reporting.setEnabled(true);
    reporting.release();
    reporting.setEnabled(true);
    await reporting.handOver(async () => {
      log.push("program");
    });
    expect(log).toEqual([ON, OFF, "program"]);
  });

  it("does not throw when the terminal cannot be written to", () => {
    const reporting = createMouseReporting(() => {
      throw new Error("EPIPE");
    });
    expect(() => reporting.setEnabled(true)).not.toThrow();
    expect(() => reporting.release()).not.toThrow();
  });
});
