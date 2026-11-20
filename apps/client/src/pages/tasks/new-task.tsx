import type { TaskResults } from "@eta/client-contracts";
import { signal, View } from "nsh";
import { Button, Caption, Field, Modal, row } from "../../components";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";

export function NewTask(props: {
  phone: boolean;
  conversation?: string;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const host = useHost();
  const title = signal("");
  const description = signal("");
  const agent = signal("");
  const conversation = signal(props.conversation ?? "");
  const backlog = signal(false);
  const busy = signal(false);
  const groups = () =>
    host
      .conversations()
      .filter((item) => item.kind === "group" && !item.archived);
  async function save() {
    if (busy() || !agent() || !title().trim()) return;
    busy.set(true);
    const result = await host.action(() =>
      host.call<TaskResults["create"]>("tasks", "create", {
        tasks: [
          {
            title: title().trim(),
            description: description().trim(),
            assignee: agent(),
          },
        ],
        status: backlog() ? "backlog" : "todo",
        conversationId: conversation() || undefined,
      }),
    );
    busy.set(false);
    if (result?.tasks[0]) {
      props.onClose();
      props.onOpen(result.tasks[0].id);
    }
  }
  return (
    <Modal
      title={uiText("newTask")}
      width={540}
      phone={props.phone}
      onClose={props.onClose}
    >
      <View style={{ padding: 16, gap: 10 }}>
        <Field
          label={uiText("title")}
          placeholder={uiText("taskTitle")}
          value={title()}
          onChange={title.set}
        />
        <Field
          label={uiText("description")}
          placeholder={uiText("describeTheWork")}
          value={description()}
          multiline
          onChange={description.set}
          style={{ height: 72 }}
        />
        <Caption text={uiText("executor")} />
        <View style={{ ...row, flexWrap: "wrap", gap: 6 }}>
          <Each of={host.people()} key={(entry) => entry.id}>
            {(entry) => (
              <Button
                label={entry().name}
                selected={agent() === entry().id}
                onPress={() => agent.set(entry().id)}
              />
            )}
          </Each>
        </View>
        <Caption text={uiText("conversation")} />
        <View style={{ ...row, flexWrap: "wrap", gap: 6 }}>
          <Button
            label={uiText("none")}
            selected={!conversation()}
            onPress={() => conversation.set("")}
          />
          <Each of={groups()} key={(entry) => entry.id}>
            {(entry) => (
              <Button
                label={entry().name}
                selected={conversation() === entry().id}
                onPress={() => conversation.set(entry().id)}
              />
            )}
          </Each>
        </View>
        <View style={{ ...row, gap: 6, justifyContent: "flex-end" }}>
          <Button
            label={uiText("backlog")}
            selected={backlog()}
            onPress={() => backlog.set(!backlog())}
          />
          <Button
            label={uiText("createTask")}
            tone="primary"
            disabled={!title().trim() || !agent() || busy()}
            onPress={() => void save()}
          />
        </View>
      </View>
    </Modal>
  );
}
