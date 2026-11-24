import type { Outgoing } from "./composer-draft";
import { View } from "nsh";
import { Button, Label, row } from "../../components";
import { uiText } from "../../i18n";

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
              <Label variant="small" tone="warning">
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
