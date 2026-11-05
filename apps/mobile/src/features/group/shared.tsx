import type { MemberStatus, SessionViewSections } from "@eta/client-contracts";
import type { JSX } from "nsh";
import { cleanup, effect, Text, View } from "nsh";
import { agentById } from "../../app/lists";
import { wire } from "../../app/session";
import { t } from "../../i18n";
import { Icon } from "../../ui/Icon";
import { reason } from "../../ui/format";
import { toast } from "../../ui/toast";

/** A call a press made: on success what comes next, on failure the host's own words. */
export function act<T>(call: Promise<T>, done?: (result: T) => void): void {
  call.then(done, (error: unknown) =>
    toast(t("common.failed", { message: reason(error) })),
  );
}

export const agentName = (id: string | null | undefined): string =>
  agentById(id)?.name ?? t("group.deletedAgent");

export const statusLabel = (status: MemberStatus): string =>
  t(`group.status.${status}`);

/** `anthropic:claude-opus-5-5` is `provider:modelId`; the phone shows the model. */
export const modelName = (id: string): string => id.slice(id.indexOf(":") + 1);

/** `48.2k`, `210k`, `1.4M`: the web's member stats, without a `.0`. */
export function tokens(count: number | undefined): string {
  if (count === undefined) return "—";
  const short = (value: number) => value.toFixed(1).replace(/\.0$/, "");
  if (count >= 1_000_000) return `${short(count / 1_000_000)}M`;
  if (count >= 1_000) return `${short(count / 1_000)}k`;
  return String(count);
}

/** `sessions.<id>` is only a target once asked for, so ask once before subscribing. */
const opened = new Set<string>();

type Session = Partial<
  Pick<
    SessionViewSections,
    "usage" | "model" | "tools" | "metrics" | "tasks" | "transcript"
  >
>;

/** One member's session, kept live while the calling component lives. As the web's `useSessionView`. */
export function useSession(
  id: () => string | null | undefined,
): () => Session | undefined {
  const connection = wire();
  effect(() => {
    const session = id();
    if (session === null || session === undefined) return;
    let gone = false;
    let release: (() => void) | undefined;
    const attach = () => {
      if (!gone) release = connection.subscribe(`sessions.${session}`);
    };
    if (opened.has(session)) attach();
    else {
      connection
        .call("sessions", "resync", { session })
        .then(
          () => opened.add(session),
          () => undefined,
        )
        .finally(attach);
    }
    cleanup(() => {
      gone = true;
      release?.();
    });
  });
  return () => {
    const session = id();
    if (session === null || session === undefined) return undefined;
    return connection.target(`sessions.${session}`)?.sections as
      | Session
      | undefined;
  };
}

/** The 14 caret at a row's end. */
export const RowCaret = () => (
  <Icon name="caretRight" size={14} color="faint" />
);

/** A 36-high caption over a group of rows: 任务 2, 2 位成员 and 邀请 beside it. */
export function Caption(props: { title: string; right?: JSX.Element }) {
  return (
    <View class="h-9 shrink-0 flex-row items-end justify-between px-4 pb-[6px]">
      <Text class="text-sm leading-[18px] text-muted-foreground">
        {props.title}
      </Text>
      {props.right}
    </View>
  );
}

/** The 52-high row of a sheet: an action, an avatar and a name, a check. */
export function SheetRow(props: {
  title: string;
  subtitle?: string;
  leading?: JSX.Element;
  trailing?: JSX.Element;
  danger?: boolean;
  thick?: boolean;
  testID?: string;
  onPress?: () => void;
}) {
  return (
    <View
      role="button"
      accessibilityLabel={props.title}
      testID={props.testID}
      onPress={() => props.onPress?.()}
      class={`h-[52px] shrink-0 flex-row items-center gap-[10px] px-4 active:bg-muted ${props.thick ? "border-t-8 border-muted" : "border-t border-border"}`}
    >
      {props.leading}
      <View class="min-w-0 grow basis-0">
        <Text
          class={`truncate text-lead leading-[20px] ${props.danger ? "text-state-error" : "text-foreground"}`}
        >
          {props.title}
        </Text>
        <If when={props.subtitle !== undefined}>
          <Text class="truncate text-sm leading-4 text-muted-foreground">
            {props.subtitle}
          </Text>
        </If>
      </View>
      {props.trailing}
    </View>
  );
}

/** A sheet's title: 本对话的主理人, 公开链接. */
export function SheetTitle(props: { title: string; body?: string }) {
  return (
    <View class="gap-[2px] px-4 pt-4 pb-3">
      <Text class="text-[17px] leading-5 text-foreground">{props.title}</Text>
      <If when={props.body !== undefined}>
        <Text class="text-md leading-[20px] text-muted-foreground">
          {props.body}
        </Text>
      </If>
    </View>
  );
}
