import type { HostAddress } from "../../app/session";
import { signal } from "nsh";
import { t } from "../../i18n";
import { toast } from "../../ui/toast";

export { parseConnectLink } from "./link";

/** What the connect form holds. A pasted or scanned link fills it. */
export const form = signal<HostAddress>({ address: "", token: "" });

/** The 扫电脑上的二维码 button. No camera yet: a scanned code goes through `parseConnectLink`. */
export function scanHostCode(): void {
  toast(t("connect.scanUnavailable"));
}
