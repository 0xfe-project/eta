import { BrainIcon } from "@phosphor-icons/react/Brain";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/workspace/app-shell";
import { Overview } from "@/components/workspace/overview";
import { SettingsButton } from "@/components/workspace/settings-dialog";

export function More() {
  return (
    <>
      <PageHeader title="更多">
        <SettingsButton />
      </PageHeader>
      <main id="main" className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <nav className="mb-6 grid gap-1" aria-label="更多分区">
          <Link
            to="/workspace/routines"
            className="flex min-h-12 items-center gap-3 border-b text-sm"
          >
            <ClockIcon className="size-5" />
            定时
          </Link>
          <Link
            to="/workspace/memory"
            className="flex min-h-12 items-center gap-3 border-b text-sm"
          >
            <BrainIcon className="size-5" />
            记忆
          </Link>
        </nav>
        <Overview />
      </main>
    </>
  );
}
