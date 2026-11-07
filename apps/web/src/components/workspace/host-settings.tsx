import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { host, openConnectionPage } from "@/lib/native";

// Settings → 连接方式, in the desktop shell only: where this window's host is. Changing it is the
// shell's business, on the shell's own page, because the choice has to work when this page's host
// is the one that is gone. This page only asks for it.

export function HostSettings() {
  const { i18n, t: translateText } = useTranslation(["settings"] as const);
  const { address, connection } = host();
  return (
    <div>
      <div className="settings-heading">
        <h2>{translateText("sections.host")}</h2>
      </div>
      <div className="settings-row">
        <div className="settings-row-label">
          <div className="break-all">
            {connection === "remote"
              ? translateText("host.remote", { address })
              : translateText("host.local")}
          </div>
          <p className="text-xs text-muted-foreground">
            {translateText("host.independent")}
          </p>
        </div>
        <div className="settings-control">
          <Button
            variant="outline"
            onClick={() => void openConnectionPage(i18n.language)}
          >
            {translateText("host.change")}
          </Button>
        </div>
      </div>
    </div>
  );
}
