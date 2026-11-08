/**
 * Where the user finds what they wrote in an edit that ended with its shell. That shell can open
 * no layer and its status line cuts long paths, so the paths wait here, per connection
 * controller, and a layer of a later shell lists them in full.
 */
import type { ConnectionController } from "../../connection/types";
import type { ShellContext } from "../../extensions/types";
import { KeptFilesLayer } from "./kept-layer";

interface Waiting {
  paths: string[];
  /** The context of the last shell that said hello. */
  latest: ShellContext | undefined;
  /** A layer for the paths was asked of `latest` and has not shown yet. */
  asked: boolean;
}

const waiting = new WeakMap<ConnectionController, Waiting>();

function waitingFor(ctx: ShellContext): Waiting {
  let entry = waiting.get(ctx.connection);
  if (entry === undefined) {
    entry = { paths: [], latest: undefined, asked: false };
    waiting.set(ctx.connection, entry);
  }
  return entry;
}

function showWaiting(entry: Waiting): void {
  const shell = entry.latest;
  if (shell === undefined || entry.asked || entry.paths.length === 0) return;
  const listed = [...entry.paths];
  entry.asked = true;
  const shown = () => {
    entry.paths = entry.paths.filter((path) => !listed.includes(path));
    entry.asked = false;
  };
  // A shell that has ended opens nothing; the paths then wait for the next hello.
  shell.openLayer((handle) => (
    <KeptFilesLayer paths={listed} handle={handle} onShown={shown} />
  ));
}

/** For `onConnected`: a new shell said hello, and lists the paths that are waiting. */
export function noteShell(ctx: ShellContext): void {
  const entry = waitingFor(ctx);
  entry.latest = ctx;
  entry.asked = false;
  showWaiting(entry);
}

/**
 * Files an edit begun in `origin`'s shell left behind. A later shell, when there is one, lists
 * them now; otherwise the next one does.
 */
export function reportKept(
  origin: ShellContext,
  paths: readonly string[],
): void {
  const entry = waitingFor(origin);
  entry.paths.push(...paths);
  if (entry.latest !== undefined && entry.latest !== origin) showWaiting(entry);
}
