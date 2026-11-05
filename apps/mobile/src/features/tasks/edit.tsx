import type { TaskArgs, TaskDetailSections } from "@eta/client-contracts";
import { signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { t } from "../../i18n";
import { nav, open } from "../../nav/stack";
import { Page } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { call, useTarget } from "../../wire/target";
import { failure } from "./format";

/** 06f: the title and the description, saved together. */
export function EditTaskScreen(props: { task: TaskDetailSections["task"] }) {
  const target = useTarget(`tasks.${props.task.id}`);
  const current = () => target.section<TaskDetailSections["task"]>("task") ?? props.task;
  const title = signal(props.task.title);
  const description = signal(props.task.description);
  const saving = signal(false);
  const canSave = () => title().trim() !== "" && !saving();
  const save = (): void => {
    if (!canSave()) return;
    const fields: TaskArgs["update"] = { taskId: props.task.id };
    if (title().trim() !== current().title) fields.title = title().trim();
    if (description() !== current().description) fields.description = description();
    if (fields.title === undefined && fields.description === undefined) {
      nav.pop();
      return;
    }
    saving.set(true);
    call("tasks", "update", fields)
      .then(
        () => nav.pop(),
        (error: unknown) => toast(t("common.failed", { message: failure(error) })),
      )
      .finally(() => saving.set(false));
  };
  return (
    <Page form>
      <View class="h-12 shrink-0 flex-row items-center justify-between px-4">
        <Text onPress={() => nav.pop()} class="text-base leading-[18px] text-muted-foreground">
          {t("common.cancel")}
        </Text>
        <Text class="text-base leading-[18px] text-foreground">{t("tasks.edit.title")}</Text>
        <View
          role="button"
          testID="task-save"
          accessibilityLabel={t("common.save")}
          onPress={save}
          class={`h-8 flex-row items-center px-3 ${canSave() ? "bg-primary active:opacity-80" : "bg-muted"}`}
        >
          <Text
            class={`text-md leading-4 ${canSave() ? "text-primary-foreground" : "text-muted-foreground"}`}
          >
            {t("common.save")}
          </Text>
        </View>
      </View>
      <View class="shrink-0 gap-1 border-t border-border px-4 py-3">
        <Text class="text-sm leading-[18px] text-muted-foreground">{t("tasks.fields.title")}</Text>
        <Input
          testID="task-title"
          value={title()}
          onChange={({ value }) => title.set(value)}
          maxLength={200}
          class="text-input leading-5 text-foreground"
        />
      </View>
      <View class="min-h-0 grow basis-0 gap-1 border-t border-border px-4 py-3">
        <Text class="text-sm leading-[18px] text-muted-foreground">
          {t("tasks.fields.description")}
        </Text>
        <Input
          testID="task-description"
          value={description()}
          onChange={({ value }) => description.set(value)}
          multiline
          maxLength={20000}
          class="min-h-0 grow basis-0 text-input leading-5 text-foreground"
        />
      </View>
      <View class="h-10 shrink-0 flex-row items-center border-t border-border px-4">
        <Text class="text-sm leading-4 text-muted-foreground">{t("tasks.edit.hint")}</Text>
      </View>
    </Page>
  );
}

export function openEditTask(task: TaskDetailSections["task"]): void {
  open(`task-edit:${task.id}`, () => <EditTaskScreen task={task} />);
}
