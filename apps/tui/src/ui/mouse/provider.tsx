import type { ReactNode } from "react";
import type { MouseReporting } from "./reporting";
import type { WheelEvents } from "./wheel";
import { useLayoutEffect } from "react";
import { WheelContext } from "../../extensions/react";
import { MouseReportingContext } from "./reporting";

/**
 * Gives the tree under it the terminal's wheel steps and its mouse reporting. When it goes away,
 * the reporting is released for good.
 */
export function MouseProvider({
  wheel,
  reporting,
  children,
}: {
  wheel: WheelEvents;
  reporting: Pick<MouseReporting, "setEnabled" | "release">;
  children: ReactNode;
}) {
  // A layout effect, so the release runs as the tree is removed: when a component throws, Ink
  // removes the tree and then leaves the alternate screen, in the same commit, before eta's crash
  // path runs.
  useLayoutEffect(() => () => reporting.release(), [reporting]);
  return (
    <WheelContext value={wheel}>
      <MouseReportingContext value={reporting}>
        {children}
      </MouseReportingContext>
    </WheelContext>
  );
}
