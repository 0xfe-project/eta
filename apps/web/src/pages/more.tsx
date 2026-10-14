import type { Icon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { BrainIcon } from "@phosphor-icons/react/Brain";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/workspace/app-shell";
import { AttentionDot } from "@/components/workspace/settings-nav";
import {
  settingsSections,
  useSettingsAttention,
} from "@/components/workspace/settings-sections";
import { useWorkspaceStore } from "@/components/workspace/workspace-store";

// The phone's way to everything the bottom tabs leave out: the pages the
// wide sidebar lists, then each settings section, opened in the dialog.

const pages = [
  { to: "/workspace/routines", label: "定时", icon: ClockIcon },
  { to: "/workspace/memory", label: "记忆", icon: BrainIcon },
] as const;

const row =
  "flex min-h-12 w-full items-center gap-3 px-4 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted active:bg-muted sm:px-6";

function RowContent({
  icon: Icon,
  label,
  children,
}: {
  icon: Icon;
  label: string;
  children?: ReactNode;
}) {
  return (
    <>
      <Icon aria-hidden="true" className="size-5 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {children}
      <CaretRightIcon
        aria-hidden="true"
        className="size-4 text-muted-foreground"
      />
    </>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  const id = `more-${title}`;
  return (
    <section aria-labelledby={id}>
      <h2
        id={id}
        className="px-4 pt-6 pb-2 text-xs font-medium text-muted-foreground sm:px-6"
      >
        {title}
      </h2>
      <ul className="divide-y border-y">{children}</ul>
    </section>
  );
}

export function More() {
  const setSettings = useWorkspaceStore((s) => s.setSettings);
  const attention = useSettingsAttention();
  return (
    <>
      <PageHeader title="更多" />
      <main id="main" className="min-h-0 flex-1 overflow-y-auto pb-6">
        <Group title="功能">
          {pages.map(({ to, label, icon }) => (
            <li key={to}>
              <Link to={to} className={row}>
                <RowContent icon={icon} label={label} />
              </Link>
            </li>
          ))}
        </Group>
        <Group title="设置">
          {settingsSections.map(({ value, label, icon }) => (
            <li key={value}>
              <button
                type="button"
                className={row}
                onClick={() => setSettings({ open: true, section: value })}
              >
                <RowContent icon={icon} label={label}>
                  {attention[value] ? (
                    <>
                      <AttentionDot />
                      <span className="sr-only">（有账号需要处理）</span>
                    </>
                  ) : null}
                </RowContent>
              </button>
            </li>
          ))}
        </Group>
      </main>
    </>
  );
}
