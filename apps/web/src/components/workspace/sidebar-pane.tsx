import { Sidebar } from "./app-shell";
import { usePaneWidth } from "./pane";

/**
 * The left column, and the line you drag to size it.
 *
 * The bounds are the ones the layout can actually hold: below 260px a folder path and a
 * conversation name cannot share a row; above 420px the pane starts competing with the chat
 * column, which is the thing being read.
 */
export function SidebarPane() {
  const pane = usePaneWidth({
    storageKey: "eta.sidebar.width",
    min: 260,
    max: 420,
    fallback: 288,
    edge: "left",
  });
  return (
    <>
      <Sidebar width={pane.width} />
      <div
        aria-label="调整左栏宽度"
        className="pane-divider hidden md:block"
        {...pane.dividerProps}
      />
    </>
  );
}
