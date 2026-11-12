import type { ReactElement, ReactNode } from "react";
import type { MouseInputSource } from "./input";
import type { MouseReporting } from "./reporting";
import { filterMouseInput } from "./input";
import { MouseProvider } from "./provider";
import { createMouseReporting } from "./reporting";
import { createWheelEvents } from "./wheel";

/** The terminal's mouse, as the interface is drawn with it. */
export interface TerminalMouse {
  /** The stdin to give Ink's `render`: the terminal's, without mouse reports. */
  stdin: NodeJS.ReadStream;
  /** The terminal's mouse reporting, for `runInterface`. */
  reporting: MouseReporting;
  /** Wraps the interface so it gets the wheel steps and the reporting, and releases it on removal. */
  provide: (ui: ReactNode) => ReactElement;
}

/** The mouse of a terminal whose stdin is `stdin` and whose stdout `write` writes to. */
export function createTerminalMouse(terminal: {
  stdin: MouseInputSource;
  write: (text: string) => unknown;
}): TerminalMouse {
  const wheel = createWheelEvents();
  const filtered = filterMouseInput(terminal.stdin, wheel.emit);
  const reporting = createMouseReporting(terminal.write);
  return {
    // Ink reads stdin only through `readable`, `read`, raw mode, encoding, `ref` and `unref`, which
    // the filtered stdin has; the rest of a ReadStream it never touches.
    stdin: filtered as unknown as NodeJS.ReadStream,
    reporting,
    provide: (ui) => (
      <MouseProvider wheel={wheel} reporting={reporting}>
        {ui}
      </MouseProvider>
    ),
  };
}
