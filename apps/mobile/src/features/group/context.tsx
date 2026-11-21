import type { CompactResult, ContextReading } from "@eta/client-contracts";
import { displayContext } from "@eta/client-contracts";
import { signal, Text, View } from "nsh";
import { language, t } from "../../i18n";
import { Button } from "../../ui/Button";
import { moment, reason } from "../../ui/format";
import { toast } from "../../ui/toast";
import { call } from "../../wire/target";
/** The member's context in the members sheet: how full, when last compacted, and Compact. */
export function ContextPanel(props: {
  session: string;
  reading: ContextReading | undefined;
}) {
  const busy = signal(false);
  const context = () =>
    displayContext(props.reading, props.session, language());
  const compact = () => {
    if (busy()) return;
    busy.set(true);
    call<CompactResult>("sessions", "compact", { session: props.session })
      .then(
        ({ compacted, runtime }) => {
          if (runtime === undefined)
            toast(t(compacted ? "group.context.done" : "group.context.empty"));
          else
            toast(
              t(`group.context.${runtime.outcome}` as const, {
                runtime: runtime.runtime,
                reason: runtime.reason ?? "",
              }),
            );
        },
        (error: unknown) =>
          toast(t("common.failed", { message: reason(error) })),
      )
      .finally(() => busy.set(false));
  };
  const last = () => {
    const at = props.reading?.compactedAt;
    if (at === null) return t("group.context.never");
    return at === undefined ? t("group.context.unknown") : moment(at);
  };
  return (
    <View class="gap-2 border-t border-border px-4 py-3" testID="context-panel">
      <View class="h-1 flex-row bg-muted">
        <View
          class="bg-foreground"
          style={{ width: `${context().fraction * 100}%` }}
        />
      </View>
      <Text class="text-md leading-[18px] text-foreground">
        {context().detail}
      </Text>
      <Text class="text-sm leading-[18px] text-muted-foreground">
        {t("group.context.lastCompaction", { time: last() })}
      </Text>
      <Button
        title={
          busy() ? t("group.context.compacting") : t("group.context.compact")
        }
        testID="context-compact"
        height={40}
        disabled={busy()}
        onPress={compact}
      />
    </View>
  );
}
