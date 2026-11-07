import type { HostAddress } from "../../app/session";
import { Scanner } from "eta/native";
import { signal } from "nsh";
import { connectTo } from "../../app/session";
import { t } from "../../i18n";
import { toast } from "../../ui/toast";
import { parseConnectLink } from "@eta/client-contracts/connect-link";

/** What the connect form holds. A pasted or scanned link fills it. */
export const form = signal<HostAddress>({ address: "", token: "" });

/** The 扫电脑上的二维码 button: the code is the link 设置 → 机器 → 连接手机 shows on the desktop. */
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
