import type { ReactNode } from "react";

/**
 * One block of the context panel: a name, how many, and whatever it holds.
 *
 * It is its own module because the panel is no longer one file's business: Captain's conversation
 * draws its own blocks (运营) in the same column as 任务/产物/成员/目标, and one 10-line heading is
 * not worth a circular import between the two.
 */
export function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="px-3 py-2">
      <h3 className="mb-1 font-mono text-[10px] tracking-[0.12em] text-faint uppercase">
        {title}
        {count === undefined ? null : (
          <span className="ml-1 tabular-nums">{count}</span>
        )}
      </h3>
      {children}
    </section>
  );
}
