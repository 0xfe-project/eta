import type { ReactNode } from "react";

/** One line of what a proposal would make: a label, and its value. */
export function ProposalField({
  label,
  mono = false,
  children,
}: {
  label: string;
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={
          mono
            ? "min-w-0 wrap-anywhere font-mono text-[11px]"
            : "min-w-0 wrap-anywhere"
        }
      >
        {children}
      </dd>
    </>
  );
}

/** The lines of what a proposal would make. */
export function ProposalFields({ children }: { children: ReactNode }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      {children}
    </dl>
  );
}
