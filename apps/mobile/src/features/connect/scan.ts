import type { HostAddress } from "../../app/session";
import { parseConnectLink } from "@eta/client-contracts/connect-link";
import { Scanner } from "eta/native";
import { signal } from "nsh";
import { connectTo } from "../../app/session";
import { t } from "../../i18n";
import { toast } from "../../ui/toast";

/** What the connect form holds. A pasted or scanned link fills it. */
export const form = signal<HostAddress>({ address: "", token: "" });

/** The Scan the QR code on your computer button: the code is the link Settings → Machine → Connect phone shows on the desktop. */
export async function scanHostCode(): Promise<void> {
  if (!Scanner.available()) {
    toast(t("connect.scanUnavailable"));
    return;
  }
  const code = await Scanner.scan();
  if (code === null || code === undefined) return;
  const target = parseConnectLink(code);
  if (target === undefined) {
    toast(t("connect.scanInvalid"));
    return;
  }
  form.set(target);
  connectTo(target);
}
