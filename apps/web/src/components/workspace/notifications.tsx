import { useTranslation } from "react-i18next";
import { PageHeader } from "./app-shell";
import { PendingList } from "./attention";

/** Everything waiting for the user, on a page of its own. */
export function Notifications() {
  const { t: translateText } = useTranslation(["navigation"] as const);
  return (
    <>
      <PageHeader title={translateText("navigation:sections.pending")} />
      <main id="main" className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-content px-1 pb-8 sm:px-3">
          <PendingList />
        </div>
      </main>
    </>
  );
}
