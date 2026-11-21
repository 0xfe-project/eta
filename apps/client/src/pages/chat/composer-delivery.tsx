import type { ConversationResults, MessageView } from "@eta/client-contracts";
import type { ViewRef } from "nsh";
import type { Outgoing } from "./composer-draft";
import { cleanup, effect, keymap, signal, View } from "nsh";
import { Button, colors, Label, row } from "../../components";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";

export function OutboxRows(props: {
  messages: Outgoing[];
  onRetry: (id: string) => void;
  onEdit: (msg: Outgoing) => void;
  onDiscard: (id: string) => void;
}) {
  return (
    <Each of={props.messages} key={(message) => message.id}>
      {(message) => (
        <View style={{ gap: 4 }}>
          <Label lines={2} variant="small">
            {[message().text, ...message().attachments.map((file) => file.name)]
              .filter(Boolean)
              .join(" · ")}
          </Label>
          <If
            when={message().failure}
            else={
              <Label variant="caption" tone="muted">
                {uiText("sendingMessage")}
              </Label>
            }
          >
            <View role="alert" style={{ ...row, gap: 6, flexWrap: "wrap" }}>
              <Label variant="small" tone="amber">
                {message().failure}
              </Label>
              <Button
                label={uiText("retry")}
                onPress={() => props.onRetry(message().id)}
              />
              <Button
                label={uiText("edit")}
                onPress={() => props.onEdit(message())}
              />
              <Button
                label={uiText("discard")}
                onPress={() => props.onDiscard(message().id)}
              />
            </View>
          </If>
        </View>
      )}
    </Each>
  );
}
export function HeldRows(props: {
  messages: MessageView[];
  conversationId: string;
  onRecall: (text: string) => void;
  rows: Map<string, ViewRef>;
}) {
  const host = useHost();
  const c = colors();
  return (
    <Each of={props.messages} key={(message) => message.id}>
      {(message) => {
        const id = message().id;
        const pending = signal(false);
        const focused = signal(false);
        cleanup(() => {
          props.rows.delete(id);
        });
        async function act(action: "steer" | "edit" | "discard") {
          if (pending()) return;
          pending.set(true);
          const held = message();
          try {
            await host.action(async () => {
              const args = {
                conversationId: props.conversationId,
                messageId: id,
              };
              if (action === "steer")
                await host.call("conversations", "steerHeld", args);
              else {
                const result = await host.call<ConversationResults["recall"]>(
                  "conversations",
                  "recall",
                  args,
                );
                if (result.recalled && action === "edit")
                  props.onRecall(held.text);
              }
            });
          } finally {
            pending.set(false);
          }
        }
        effect(() => {
          if (!focused()) return;
          return keymap.bind(
            {
              "mod+enter": () => void act("steer"),
              e: () => void act("edit"),
              delete: () => void act("discard"),
            },
            { when: "always" },
          );
        });
        return (
          <View
            ref={(ref) => props.rows.set(id, ref)}
            focusable
            onFocus={() => focused.set(true)}
            onBlur={() => focused.set(false)}
            accessibilityLabel={uiText("queuedWithCount", {
              text: message().text,
            })}
            focusVisibleStyle={{ outlineWidth: 1, outlineColor: c().blue }}
            style={{ ...row, gap: 6 }}
          >
            <Label variant="small" tone="muted" style={{ flex: 1 }} lines={1}>
              {uiText("queuedWithCount", { text: message().text })}
            </Label>
            <Button
              label={uiText("steer")}
              disabled={pending()}
              onPress={() => void act("steer")}
            />
            <Button
              label={uiText("recall")}
              disabled={pending()}
              onPress={() => void act("edit")}
            />
            <Button
              label={uiText("discard")}
              disabled={pending()}
              onPress={() => void act("discard")}
            />
          </View>
        );
      }}
    </Each>
  );
}
