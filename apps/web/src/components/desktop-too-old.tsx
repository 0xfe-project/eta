import { desktopTooOld, MIN_DESKTOP } from "@eta/client-contracts/desktop";
import { XIcon } from "@phosphor-icons/react/X";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { host } from "@/lib/native";

// The one place this page compares the desktop app's version: when its host has said the app is
// too old for it (`MIN_DESKTOP`, `@eta/client-contracts/desktop`). Anything less than that is a
// capability check (`hasCapability`), and draws nothing here. It sits over the bottom of the
// window, so it can be put away until the next load.

export function DesktopTooOld({ min = MIN_DESKTOP }: { min?: string }) {
  const { t: translateText } = useTranslation(["common"] as const);
  const [dismissed, setDismissed] = useState(false);
  const { appVersion } = host();
  if (dismissed || !desktopTooOld(appVersion, min)) return null;
  return (
    <div
      role="alert"
      className="fixed inset-x-0 bottom-0 z-50 flex items-center gap-2 border-t bg-background py-1 pr-1 pl-4 text-sm"
    >
      <span className="flex-1">
        {translateText("desktop.tooOld", { min, current: appVersion })}
      </span>
      <Button
        variant="ghost"
        size="icon"
        aria-label={translateText("actions.close")}
        onClick={() => setDismissed(true)}
      >
        <XIcon />
      </Button>
    </div>
  );
}
