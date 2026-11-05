import { Text, View } from "nsh";
import { wire } from "../app/session";
import { t } from "../i18n";

/** 08b: the connection dropped; what is on screen may be stale. Shown under the status bar. */
export function ConnectionBanner() {
  return (
    <If when={wire().status() === "reconnecting"}>
      <View class="h-9 shrink-0 justify-center bg-muted px-4">
        <Text class="text-sm leading-4 text-foreground">{t("connect.reconnecting")}</Text>
      </View>
    </If>
  );
}
