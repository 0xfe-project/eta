import type { ConversationArgs, ConversationSummary } from "@eta/client-contracts";
import { signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { machineById, projectById } from "../../app/lists";
import { t } from "../../i18n";
import { Button } from "../../ui/Button";
import { reason } from "../../ui/format";
import { Sheet } from "../../ui/Sheet";
import { toast } from "../../ui/toast";
import { call } from "../../wire/target";

export const updateConversation = (args: ConversationArgs["update"]): Promise<unknown> =>
  call("conversations", "update", args);

function place(conversation: ConversationSummary | undefined): string {
  const project = projectById(conversation?.projectId);
  if (conversation?.kind === "direct" || project === undefined) return "";
  const machine = machineById(project.machineId);
  return machine === undefined ? project.name : `${project.name} · ${machine.name}`;
}

function Action(props: { title: string; onPress: () => void }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.title}
      onPress={props.onPress}
      class="h-[52px] shrink-0 flex-row items-center border-t border-border px-4 active:bg-muted"
    >
      <Text class="text-lead leading-[18px] text-foreground">{props.title}</Text>
    </View>
  );
}

/** 03p: what a long press on a row offers. A private chat bears its agent's name: no 改名. */
export function ConversationSheet(props: {
  open: boolean;
  conversation: ConversationSummary | undefined;
  onClose: () => void;
}) {
  const renaming = signal(false);
  const draft = signal("");
  const close = () => {
    renaming.set(false);
    props.onClose();
  };
  const id = () => props.conversation?.id ?? "";
  const update = (args: Omit<ConversationArgs["update"], "conversationId">) => {
    const conversationId = id();
    close();
    updateConversation({ conversationId, ...args }).catch((error: unknown) =>
      toast(t("common.failed", { message: reason(error) })),
    );
  };
  const name = () => draft().trim();
  return (
    <Sheet open={props.open} onClose={close} testID="conversation-sheet">
      <If
        when={renaming()}
        else={
          <>
            <View class="gap-[2px] p-4">
              <Text class="truncate text-[17px] leading-5 text-foreground">
                {props.conversation?.name}
              </Text>
              <If when={place(props.conversation) !== ""}>
                <Text class="truncate text-md leading-[18px] text-muted-foreground">
                  {place(props.conversation)}
                </Text>
              </If>
            </View>
            <If when={props.conversation?.kind !== "direct"}>
              <Action
                title={t("conversations.rename")}
                onPress={() => {
                  draft.set(props.conversation?.name ?? "");
                  renaming.set(true);
                }}
              />
            </If>
            <Action title={t("conversations.archive")} onPress={() => update({ archived: true })} />
          </>
        }
      >
        <View class="gap-3 p-4">
          <Text class="text-[17px] leading-5 text-foreground">{t("conversations.rename")}</Text>
          <Input
            testID="rename-input"
            autoFocus
            value={draft()}
            onChange={({ value }) => draft.set(value)}
            placeholder={t("conversations.renamePlaceholder")}
            maxLength={100}
            class="h-11 border border-border-strong px-3 text-input text-foreground placeholder:text-faint"
          />
          <View class="flex-row gap-2">
            <Button title={t("common.cancel")} height={44} onPress={close} />
            <Button
              title={t("common.save")}
              height={44}
              variant="primary"
              disabled={name() === "" || name() === props.conversation?.name}
              onPress={() => update({ name: name() })}
            />
          </View>
        </View>
      </If>
    </Sheet>
  );
}
