/**
 * A compaction driver for kernel tests.
 *
 * Core tests the runner's compaction *protocol* — ask once before the first
 * request, recover an overflow once per run, adopt what the driver hands back —
 * and that protocol is all the kernel knows. The arithmetic and the real
 * summarizer live in `@eta/harness` and the compaction plugin, so a kernel test
 * that wanted them would be testing someone else's work through the kernel.
 *
 * What this fake does: records how it was asked, and replaces the context with
 * canned text plus whatever tail it is told to keep.
 */
import type { CompactionDriver, CompactionHost } from "../kernel/compaction";

export type CompactionSignal = "threshold" | "overflow" | "manual";

export interface FakeCompactionOptions {
  /** What the replacement context says. */
  summary?: string;
  /** Messages kept verbatim after the cut. */
  retainedTail?: readonly unknown[];
  /**
   * Which signals actually replace the context. The defaults mirror the real
   * service on a history that fits: `threshold` declines, `overflow` and
   * `manual` compact.
   */
  compacts?: Partial<Record<CompactionSignal, boolean>>;
  /** Called whenever a signal replaces the context, so a test can inspect it. */
  onCompact?: (reason: CompactionSignal, host: CompactionHost) => void;
}

export interface FakeCompaction extends CompactionDriver {
  /** The host-facing verb a real service also has (a `/compact` command). */
  manual(): Promise<boolean>;
  /** Every ask, in order, including the ones that declined. */
  readonly signals: CompactionSignal[];
  /** The asks that replaced the context, in order. */
  readonly compactions: CompactionSignal[];
}

export function fakeCompaction(
  options: FakeCompactionOptions = {},
): FakeCompaction {
  const summary =
    options.summary ?? "everything before was about the migration";
  const compacts: Record<CompactionSignal, boolean> = {
    threshold: options.compacts?.threshold ?? false,
    overflow: options.compacts?.overflow ?? true,
    manual: options.compacts?.manual ?? true,
  };
  const signals: CompactionSignal[] = [];
  const compactions: CompactionSignal[] = [];
  let host: CompactionHost | undefined;

  const ask = (reason: CompactionSignal): boolean => {
    signals.push(reason);
    if (host === undefined || !compacts[reason]) return false;
    compactions.push(reason);
    options.onCompact?.(reason, host);
    host.replaceContext(summary, {
      retainedTail: (options.retainedTail ?? []) as never,
      tokensBefore: 1_000,
    });
    return true;
  };

  return {
    signals,
    compactions,
    attach(next: CompactionHost) {
      host = next;
    },
    threshold: async () => ask("threshold"),
    overflow: async () => ask("overflow"),
    manual: async () => ask("manual"),
  };
}
