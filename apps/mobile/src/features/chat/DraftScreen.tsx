import type {
  BoardTaskDetail,
  MessageView,
  TaskDraftData,
  TaskFields,
} from "@eta/client-contracts";
import { signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { t } from "../../i18n";
import { nav } from "../../nav/stack";
import { Button } from "../../ui/Button";
import { reason } from "../../ui/format";
import { Icon } from "../../ui/Icon";
import { Page } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { call } from "../../wire/target";
import { BottomInset } from "./BottomInset";
import { rememberRows } from "./rows";

/** 03e: the draft edited and confirmed. Confirming creates the task and its executor starts. */
export function DraftScreen(props: { message: MessageView }) {
  const draft = props.message.data as unknown as TaskDraftData;
  const title = signal(draft.title);
  const description = signal(draft.description);
  const busy = signal(false);
  const confirm = () => {
    const edits: TaskFields = {
      ...(title() === draft.title ? {} : { title: title() }),
      ...(description() === draft.description
        ? {}
        : { description: description() }),
    };
    busy.set(true);
    call<{ task: BoardTaskDetail; message: MessageView }>(
      "tasks",
      "confirmDraft",
      {
        conversationId: props.message.conversationId,
        messageId: props.message.id,
        ...(Object.keys(edits).length === 0 ? {} : { edits }),
      },
    ).then(
      ({ message }) => {
        rememberRows(message.conversationId, [message]);
        nav.pop();
      },
      (error: unknown) => {
        busy.set(false);
        toast(t("common.failed", { message: reason(error) }));
      },
    );
  };
  return (
    <Page bottom={false}>
      <View class="flex-1 pb-[env(keyboard-inset-height)]">
        <View class="h-12 shrink-0 flex-row items-center px-2">
          <View
            role="button"
            accessibilityLabel={t("common.close")}
            onPress={() => nav.pop()}
            class="h-11 w-10 items-center justify-center active:opacity-60"
          >
            <Icon name="x" size={20} />
          </View>
        </View>
        <View class="shrink-0 gap-1 px-4 pt-1 pb-4">
          <Text class="text-title leading-[30px] tracking-[-0.01em] text-foreground">
            {t("chat.draft.title")}
          </Text>
          <Text class="text-md leading-[20px] text-muted-foreground">
            {t("chat.draft.subtitle")}
          </Text>
        </View>
        <View class="min-h-0 grow basis-0 gap-4 px-4">
          <View class="gap-[6px]">
            <Text class="text-sm leading-[18px] text-muted-foreground">
              {t("chat.draft.field.title")}
            </Text>
            <Input
              accessibilityLabel={t("chat.draft.field.title")}
              value={title()}
              onChange={({ value }) => title.set(value)}
              class="h-11 shrink-0 border border-border-strong px-3 text-input leading-[20px] text-foreground"
            />
          </View>
          <View class="min-h-0 grow basis-0 gap-[6px]">
            <Text class="text-sm leading-[18px] text-muted-foreground">
              {t("chat.draft.field.description")}
            </Text>
            <Input
              accessibilityLabel={t("chat.draft.field.description")}
              multiline
              value={description()}
              onChange={({ value }) => description.set(value)}
              class="grow basis-0 border border-border-strong px-3 py-[10px] text-input leading-5 text-foreground"
            />
          </View>
          <Text class="text-md leading-[20px] text-muted-foreground">
            {t(
              draft.workspace === "worktree"
                ? "chat.draft.hintWorktree"
                : "chat.draft.hintLocal",
            )}
          </Text>
        </View>
        <View class="shrink-0 flex-row px-4 pt-4 pb-2">
          <Button
            title={t("chat.draft.submit")}
            variant="primary"
            height={48}
            disabled={busy() || title().trim() === ""}
            onPress={confirm}
          />
        </View>
        <BottomInset />
      </View>
    </Page>
  );
}
