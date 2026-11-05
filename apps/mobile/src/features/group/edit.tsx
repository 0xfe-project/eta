// 03m 编辑群信息: name, goal and what has been decided. The form starts from the first `info` the
// conversation's target gives, and later pushes do not overwrite what is being typed.

import type { ConversationInfo } from "@eta/client-contracts";
import { effect, signal, Text, untracked, View } from "nsh";
import { Input } from "nsh/base";
import { t } from "../../i18n";
import { nav } from "../../nav/stack";
import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";
import { Body, Page } from "../../ui/Page";
import { Loading } from "../../ui/States";
import { call, useTarget } from "../../wire/target";
import { act } from "./shared";

const FIELD = "text-input text-foreground";
/** The two long fields share what is left of the screen; under a keyboard they stop here and the page scrolls. */
const LONG_FIELD_HEIGHT = 120;

function Label(props: { text: string }) {
  return (
    <Text class="text-sm leading-[18px] text-muted-foreground">
      {props.text}
    </Text>
  );
}

export function EditGroupScreen(props: { id: string }) {
  const target = useTarget(`conversations.${props.id}`);
  const info = () => target.section<ConversationInfo>("info");
  const name = signal("");
  const goal = signal("");
  const decided = signal("");
  const ready = signal(false);
  effect(() => {
    const current = info();
    if (current === undefined || untracked(ready)) return;
    name.set(current.name);
    goal.set(current.goal);
    decided.set(current.decided);
    ready.set(true);
  });
  const valid = () => name().trim() !== "";
  const save = () =>
    act(
      call("conversations", "update", {
        conversationId: props.id,
        name: name().trim(),
        goal: goal(),
        decided: decided(),
      }),
      () => nav.pop(),
    );
  return (
    <Page form>
      <View class="h-12 shrink-0 flex-row items-center px-2">
        <View
          role="button"
          accessibilityLabel={t("common.close")}
          testID="back"
          onPress={() => nav.pop()}
          class="h-11 w-10 items-center justify-center active:opacity-60"
        >
          <Icon name="x" size={20} />
        </View>
      </View>
      <If when={ready()} else={<Loading />}>
        <Body fill class="gap-4 px-4">
          <View class="gap-1 pt-1">
            <Text class="text-title leading-[30px] tracking-[-0.01em] text-foreground">
              {t("group.edit.title")}
            </Text>
            <Text class="text-md leading-[20px] text-muted-foreground">
              {t("group.edit.hint")}
            </Text>
          </View>
          <View class="gap-[6px]">
            <Label text={t("group.edit.name")} />
            <Input
              testID="edit-name"
              value={name()}
              onChange={(event) => name.set(event.value)}
              class={`h-11 border border-border-strong px-3 ${FIELD}`}
            />
          </View>
          <View
            class="grow basis-0 gap-[6px]"
            style={{ minHeight: LONG_FIELD_HEIGHT }}
          >
            <Label text={t("group.edit.goal")} />
            <Input
              testID="edit-goal"
              multiline
              value={goal()}
              onChange={(event) => goal.set(event.value)}
              class={`grow basis-0 border border-border-strong px-3 py-[10px] ${FIELD}`}
            />
          </View>
          <View
            class="grow basis-0 gap-[6px]"
            style={{ minHeight: LONG_FIELD_HEIGHT }}
          >
            <Label text={t("group.edit.decided")} />
            <Input
              testID="edit-decided"
              multiline
              value={decided()}
              onChange={(event) => decided.set(event.value)}
              class={`grow basis-0 border border-border-strong px-3 py-[10px] ${FIELD}`}
            />
          </View>
        </Body>
        <View class="shrink-0 flex-row px-4 pt-4 pb-2">
          <Button
            title={t("common.save")}
            variant="primary"
            height={48}
            disabled={!valid()}
            onPress={save}
          />
        </View>
      </If>
    </Page>
  );
}
