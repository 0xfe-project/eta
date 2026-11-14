import { toast } from "sonner";
import { translate } from "@/lib/i18n";

// A tab opened before a deploy keeps running the code it loaded, which the
// wire contract may have outgrown. Whenever the tab is in
// view, compare its build with the server's and offer a reload once they
// differ.
const CHECK_EVERY = 5 * 60_000;

let offered = false;

async function checkForUpdate() {
  if (offered || document.visibilityState !== "visible") return;
  const response = await fetch("/version", { cache: "no-store" }).catch(
    () => null,
  );
  // Offline, or a server without the route: nothing to compare.
  if (!response?.ok) return;
  if ((await response.text()) === __ETA_BUILD__) return;
  offered = true;
  toast(translate("common:updates.available"), {
    duration: Infinity,
    action: {
      label: translate("common:actions.refresh"),
      onClick: () => location.reload(),
    },
  });
}

export function watchForUpdates() {
  document.addEventListener("visibilitychange", () => void checkForUpdate());
  setInterval(() => void checkForUpdate(), CHECK_EVERY);
}
