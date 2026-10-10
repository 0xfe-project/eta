import { PageHeader } from "./app-shell";
import { PendingList } from "./attention";

/** What waits for the user. */
export function Notifications() {
  return (
    <>
      <PageHeader title="待处理" />
      <main id="main" className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-1 pb-8 sm:px-3">
          <PendingList />
        </div>
      </main>
    </>
  );
}
