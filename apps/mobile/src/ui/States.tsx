import { Text, View } from "nsh";
import { t } from "../i18n";
import { Button } from "./Button";

/** This task no longer exists and its kin: says what happened and stops. */
export function Empty(props: { title: string; body?: string }) {
  return (
    <View class="gap-1 px-4 py-[24px]">
      <Text class="text-input leading-[20px] text-foreground">
        {props.title}
      </Text>
      <If when={props.body !== undefined}>
        <Text class="text-md leading-[18px] text-muted-foreground">
          {props.body}
        </Text>
      </If>
    </View>
  );
}

/** Grey bars the height of what is coming, never a spinner. */
export function Loading() {
  return (
    <View class="gap-3 px-4 py-6" accessibilityLabel={t("common.loading")}>
      <View class="h-[22px] w-[220px] bg-muted" />
      <View class="h-3 w-[320px] max-w-full bg-muted" />
      <View class="h-3 w-[280px] max-w-full bg-muted" />
      <View class="h-3 w-[180px] max-w-full bg-muted" />
    </View>
  );
}

/** Unable to load task: what failed, and the one thing to do about it. */
export function Failed(props: {
  title: string;
  body?: string;
  onRetry?: () => void;
}) {
  return (
    <View class="gap-3 px-4 py-[24px]">
      <View class="gap-1">
        <Text class="text-input leading-[20px] text-foreground">
          {props.title}
        </Text>
        <Text class="text-md leading-[18px] text-muted-foreground">
          {props.body ?? t("common.lostConnection")}
        </Text>
      </View>
      <If when={props.onRetry !== undefined}>
        <View class="w-24">
          <Button title={t("common.retry")} onPress={props.onRetry} />
        </View>
      </If>
    </View>
  );
}
