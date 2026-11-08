/** How the pending feature's layers are opened. */
import type { ShellContext } from "../../extensions/types";
import { translatorFor } from "../../i18n/messages";
import { pendingMessages } from "./messages";
import { pendingItems } from "./model";
import { Panel } from "./panel";
import { Review } from "./review";
import { TaskList } from "./task-list";

/** The panel each shell has open; a shell opens one at most. */
const panels = new WeakMap<ShellContext, () => void>();

/** Opens the panel, unless this shell has it open already. */
export function openPanel(ctx: ShellContext): void {
  if (panels.has(ctx)) return;
  const layer = ctx.openLayer(() => <Panel close={close} />);
  function close() {
    panels.delete(ctx);
    layer.close();
  }
  panels.set(ctx, close);
}

/** Opens review mode, or says that nothing waits. */
export function openReview(ctx: ShellContext): void {
  const first = pendingItems(ctx.wire.store.getState())[0];
  if (first === undefined) {
    ctx.notify(
      translatorFor(pendingMessages, ctx.locale)("nothingWaiting"),
      "info",
    );
    return;
  }
  ctx.openLayer((handle) => <Review handle={handle} first={first} />);
}

/** Opens the `/tasks` layer. */
export function openTaskList(ctx: ShellContext): void {
  ctx.openLayer((handle) => <TaskList handle={handle} />);
}
