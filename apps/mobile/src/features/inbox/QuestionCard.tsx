import type { InboxResponse, InteractionView } from "@eta/client-contracts";
import { signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { agentById, conversations } from "../../app/lists";
import { wire } from "../../app/session";
import { t } from "../../i18n";
import { AgentAvatar } from "../../ui/AgentAvatar";
import { clock, reason } from "../../ui/format";
import { Icon } from "../../ui/Icon";
import { toast } from "../../ui/toast";
import { call } from "../../wire/target";

/** To the inbox an approval is a question with these two options; the words are the host's. */
const isApproval = (interaction: InteractionView) =>
  interaction.options.length === 2 &&
  interaction.options[0] === "allow" &&
  interaction.options[1] === "deny";

/** A choice in a row of them. `stale`: visible, but nothing to press (08b). */
function Choice(props: {
  title: string;
  primary?: boolean;
  stale?: boolean;
  hug?: boolean;
  onPress: () => void;
}) {
  const box = () => {
    if (props.stale) return props.primary ? "bg-muted" : "border border-border";
    return props.primary
      ? "bg-primary active:opacity-80"
      : "border border-border-strong active:bg-muted";
  };
  const label = () => {
    if (props.stale) return "text-faint";
    return props.primary ? "text-primary-foreground" : "text-foreground";
  };
  return (
    <View
      role="button"
      accessibilityLabel={props.title}
      onPress={() => {
        if (!props.stale) props.onPress();
      }}
      class={`h-10 flex-row items-center justify-center ${props.hug ? "px-4" : "min-w-0 grow basis-0 px-1"} ${box()}`}
    >
      <Text class={`text-base leading-[18px] ${label()}`}>{props.title}</Text>
    </View>
  );
}

function GiveUp(props: {
  width?: number;
  testID: string;
  onPress: () => void;
}) {
  return (
    <View
      role="button"
      accessibilityLabel={t("inbox.ask.giveUp")}
      testID={props.testID}
      onPress={props.onPress}
      class={`items-center justify-center active:opacity-60 ${props.width === undefined ? "h-[24px] w-12 items-end self-end" : "h-10 shrink-0"}`}
      style={props.width === undefined ? undefined : { width: props.width }}
    >
      <Text class="text-md leading-4 text-muted-foreground">
        {t("inbox.ask.giveUp")}
      </Text>
    </View>
  );
}

function Check(props: {
  title: string;
  on: boolean;
  stale: boolean;
  onPress: () => void;
}) {
  const border = () => {
    if (props.stale) return "border border-border";
    return props.on
      ? "bg-muted border border-foreground"
      : "border border-border-strong active:bg-muted";
  };
  return (
    <View
      role="checkbox"
      accessibilityLabel={props.title}
      accessibilityState={{ checked: props.on }}
      onPress={() => {
        if (!props.stale) props.onPress();
      }}
      class={`h-11 shrink-0 flex-row items-center gap-[10px] px-3 ${border()}`}
    >
      <If
        when={props.on}
        else={
          <View
            class={`size-[18px] shrink-0 border ${props.stale ? "border-border" : "border-border-strong"}`}
          />
        }
      >
        <View
          class={`size-[18px] shrink-0 items-center justify-center ${props.stale ? "bg-muted" : "bg-primary"}`}
        >
          <Icon
            name="check"
            size={12}
            color={props.stale ? "faint" : "primary-foreground"}
          />
        </View>
      </If>
      <Text
        class={`text-base leading-[18px] ${props.stale ? "text-faint" : "text-foreground"}`}
      >
        {props.title}
      </Text>
    </View>
  );
}

/** A pending question, answerable where it stands: in the inbox and over a chat's composer. */
export function QuestionCard(props: {
  interaction: InteractionView;
  compact?: boolean;
}) {
  const picked = signal<string[]>([]);
  const text = signal("");
  const sending = signal(false);
  /** While the connection is down nothing can reach the host, and what shows may be out of date. */
  const stale = () => wire().status() !== "open";

  const headline = () => props.interaction.prompt.split("\n")[0] ?? "";
  const details = () =>
    props.interaction.prompt.split("\n").slice(1).join("\n").trim();
  const approval = () => isApproval(props.interaction);
  const options = () => props.interaction.options;
  const freeform = () => options().length === 0;
  /** Three answers fill a row, so 放弃 takes a line of its own. */
  const giveUpBelow = () => !props.interaction.multi && options().length >= 3;
  /** More than a row can hold: one under the other. */
  const stacked = () => options().length > 3;
  const giveUpID = () => `give-up-${props.interaction.id}`;

  const who = () => agentById(props.interaction.agentId)?.name;
  const where = () => {
    const conversation = conversations().find(
      (row) => row.id === props.interaction.conversationId,
    );
    if (conversation === undefined) return "";
    return conversation.kind === "direct"
      ? t("inbox.direct")
      : conversation.name;
  };

  const send = async (response: InboxResponse) => {
    if (sending() || stale()) return;
    sending.set(true);
    try {
      await call("inbox", "answer", { id: props.interaction.id, response });
    } catch (error) {
      toast(t("common.failed", { message: reason(error) }));
    } finally {
      sending.set(false);
    }
  };
  const choose = (selections: string[]) =>
    send({ kind: "selection", selections });
  const giveUp = () => send({ kind: "none" });
  const reply = () => {
    const answer = text().trim();
    if (answer !== "") void send({ kind: "freeform", text: answer });
  };
  const toggle = (option: string) =>
    picked.update((now) =>
      now.includes(option)
        ? now.filter((item) => item !== option)
        : [...now, option],
    );
  const label = (option: string) => {
    if (!approval()) return option;
    return t(option === "allow" ? "inbox.ask.allow" : "inbox.ask.deny");
  };

  const choices = () => (
    <Each of={options()}>
      {(option, index) => (
        <Choice
          title={label(option())}
          primary={index() === 0}
          stale={stale()}
          onPress={() => void choose([option()])}
        />
      )}
    </Each>
  );

  return (
    <View
      class={
        props.compact
          ? "shrink-0 gap-2 border-t-2 border-foreground px-4 py-3"
          : "gap-[10px] border-b border-border px-4 py-[14px]"
      }
    >
      <If when={!stale()}>
        <If
          when={props.compact}
          else={
            <View class="flex-row items-center gap-2">
              <AgentAvatar
                id={props.interaction.agentId ?? props.interaction.sessionId}
                size={20}
              />
              <If when={who() !== undefined}>
                <Text class="text-md leading-[18px] text-foreground">
                  {who()}
                </Text>
              </If>
              <Text class="min-w-0 grow basis-0 truncate text-sm leading-[18px] text-muted-foreground">
                {where()}
              </Text>
              <Text class="text-sm leading-[18px] text-muted-foreground">
                {clock(props.interaction.createdAt)}
              </Text>
            </View>
          }
        >
          <View class="h-[18px] shrink-0 flex-row items-center">
            <Text class="truncate text-sm leading-4 text-muted-foreground">
              {t("inbox.ask.who", { agent: who() ?? "" })}
            </Text>
          </View>
        </If>
      </If>

      <Text
        class={`${props.compact ? "text-lead leading-[22px]" : "text-input leading-[24px]"} ${stale() ? "text-muted-foreground" : "text-foreground"}`}
      >
        {headline()}
      </Text>

      <If when={details() !== ""}>
        <If
          when={approval()}
          else={
            <Text class="text-base leading-[23px] text-muted-foreground">
              {details()}
            </Text>
          }
        >
          <View class="bg-muted px-[10px] py-2">
            <Text class="text-sm leading-[18px] text-foreground">
              {details()}
            </Text>
          </View>
        </If>
      </If>

      <If when={props.interaction.multi}>
        <View class="gap-2">
          <Each of={options()}>
            {(option) => (
              <Check
                title={option()}
                on={picked().includes(option())}
                stale={stale()}
                onPress={() => toggle(option())}
              />
            )}
          </Each>
        </View>
        <View class="flex-row gap-2">
          <Choice
            title={
              picked().length === 0
                ? t("common.send")
                : t("inbox.ask.sendCount", { count: picked().length })
            }
            primary
            stale={stale() || picked().length === 0}
            onPress={() =>
              void choose(
                options().filter((option) => picked().includes(option)),
              )
            }
          />
          <If when={!stale()}>
            <GiveUp
              width={64}
              testID={giveUpID()}
              onPress={() => void giveUp()}
            />
          </If>
        </View>
      </If>

      <If when={!props.interaction.multi && freeform()}>
        <View class="flex-row gap-2">
          <Input
            value={text()}
            onChange={({ value }) => text.set(value)}
            onSubmit={reply}
            readonly={stale()}
            placeholder={t("inbox.ask.reply")}
            returnKeyType="send"
            accessibilityLabel={t("inbox.ask.reply")}
            class={`h-10 min-w-0 grow basis-0 bg-muted px-3 text-input leading-[20px] placeholder:text-faint ${stale() ? "text-muted-foreground" : "text-foreground"}`}
          />
          <Choice
            title={t("common.send")}
            hug
            stale={stale()}
            onPress={reply}
          />
          <If when={!stale()}>
            <GiveUp
              width={48}
              testID={giveUpID()}
              onPress={() => void giveUp()}
            />
          </If>
        </View>
      </If>

      <If when={!props.interaction.multi && !freeform()}>
        <If
          when={stacked()}
          else={
            <View class="flex-row gap-2">
              {choices()}
              <If when={!giveUpBelow() && !stale()}>
                <GiveUp
                  width={64}
                  testID={giveUpID()}
                  onPress={() => void giveUp()}
                />
              </If>
            </View>
          }
        >
          <View class="gap-2">
            <Each of={options()}>
              {(option, index) => (
                <View class="flex-row">
                  <Choice
                    title={label(option())}
                    primary={index() === 0}
                    stale={stale()}
                    onPress={() => void choose([option()])}
                  />
                </View>
              )}
            </Each>
          </View>
        </If>
        <If when={giveUpBelow() && !stale()}>
          <GiveUp testID={giveUpID()} onPress={() => void giveUp()} />
        </If>
      </If>
    </View>
  );
}
