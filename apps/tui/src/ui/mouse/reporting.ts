import { createContext } from "react";

/** Basic mouse reporting (mode 1000) with SGR coordinates (mode 1006). */
export const MOUSE_REPORTING_ON = "\u001B[?1000h\u001B[?1006h";
export const MOUSE_REPORTING_OFF = "\u001B[?1006l\u001B[?1000l";

/**
 * The terminal's mouse reporting. It is on while the `mouse` setting is on, eta has the terminal,
 * and eta has not ended; it writes to the terminal only when that changes.
 */
export interface MouseReporting {
  /** Applies the `mouse` setting in effect. */
  setEnabled: (enabled: boolean) => void;
  /**
   * Runs `task` (a program on the terminal) with the reporting off, and turns it back on after,
   * also when `task` throws or rejects; returns what `task` does.
   */
  handOver: <T>(task: () => Promise<T>) => Promise<T>;
  /** Turns the reporting off for good, as eta ends; nothing turns it on again. */
  release: () => void;
}

/** The reporting, written to the terminal with `write`. A write that throws is ignored. */
export function createMouseReporting(
  write: (text: string) => unknown,
): MouseReporting {
  let enabled = false;
  let handedOver = 0;
  let released = false;
  let on = false;

  const sync = () => {
    const wanted = enabled && handedOver === 0 && !released;
    if (wanted === on) return;
    on = wanted;
    try {
      write(wanted ? MOUSE_REPORTING_ON : MOUSE_REPORTING_OFF);
    } catch {
      // Only a terminal that has gone away refuses the write, and then there is nothing to restore.
    }
  };

  return {
    setEnabled: (next) => {
      enabled = next;
      sync();
    },
    handOver: async (task) => {
      handedOver += 1;
      sync();
      try {
        return await task();
      } finally {
        handedOver -= 1;
        sync();
      }
    },
    release: () => {
      released = true;
      sync();
    },
  };
}

/**
 * The reporting the App applies the `mouse` setting to. Without a provider the setting changes
 * nothing, as for an App drawn without a terminal.
 */
export const MouseReportingContext = createContext<
  Pick<MouseReporting, "setEnabled">
>({ setEnabled: () => {} });
