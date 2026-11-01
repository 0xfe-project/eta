import type { Icon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

/** Marks places that need the user: accounts to act on, fields to fix. */
export function AttentionDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-1.5 shrink-0 bg-destructive", className)}
    />
  );
}

/**
 * Settings' section list: a column beside the content, a scrolling row
 * above it on phones. A section with `attention` shows a dot, `hint` names
 * it to screen readers. The open section scrolls into view, for sections
 * opened from elsewhere (the phone's 更多 page).
 */
export function SettingsNav<T extends string>({
  label,
  sections,
  value,
  onChange,
}: {
  label: string;
  sections: readonly {
    value: T;
    label: string;
    icon: Icon;
    attention?: boolean;
    hint?: string;
  }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <nav
      aria-label={label}
      className="flex shrink-0 gap-1 overflow-x-auto border-b p-2 md:w-44 md:flex-col md:border-r md:border-b-0"
    >
      {sections.map(
        ({ value: section, label, icon: Icon, attention, hint }) => (
          <button
            key={section}
            type="button"
            aria-current={value === section ? "page" : undefined}
            ref={
              value === section
                ? (button) => button?.scrollIntoView({ block: "nearest" })
                : undefined
            }
            onClick={() => onChange(section)}
            className={cn(
              "flex shrink-0 items-center gap-2 px-2 py-2 text-sm whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
              value === section &&
                "bg-accent font-medium text-accent-foreground",
            )}
          >
            <Icon aria-hidden="true" className="size-4" />
            {label}
            {attention ? (
              <>
                <AttentionDot className="ml-auto" />
                {hint ? <span className="sr-only">（{hint}）</span> : null}
              </>
            ) : null}
          </button>
        ),
      )}
    </nav>
  );
}
