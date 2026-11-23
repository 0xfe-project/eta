import type {
  AgentView,
  ConversationSummary,
  MemberStatus,
  MemberView,
  MessageView,
} from "@eta/client-contracts";
import type { Layout } from "../../src/components";
import { mount, View, windowSize } from "nsh";
import { Button } from "../../src/components";
import { Conversation } from "../../src/pages/chat/conversation";
import { resumeComposerOutbox } from "../../src/pages/chat/composer-draft";
import { createHost, Host } from "../../src/services/host";

/**
 * A group with Ada, its steward, on a scripted host. The buttons play the host: Ada starts or ends
 * a reply, the next send is held back until "Answer" (so the message is seen on its way), the host
 * holds what it is sent whatever the client thought, sends fail, the connection drops and comes
 * back, and someone else's message lands first.
 */
const member = (status: MemberStatus): MemberView => ({
  agentId: "ada",
  sessionId: "s-ada",
  lastSeq: 0,
  status,
});
const summary = (status: MemberStatus): ConversationSummary => ({
  id: "group",
  projectId: "project",
  kind: "group",
  name: "Website redesign",
  archived: false,
  stewardId: "ada",
  participants: [member(status)],
  lastSeq: 0,
  readSeq: 0,
  unread: 0,
  preview: "",
  lastMessageAt: null,
  createdAt: 0,
  updatedAt: 0,
});

function Fixture() {
  const host = createHost();
  const list = <T,>(items: T[]) => ({
    sections: { list: items },
    revisions: {},
    version: 0,
  });
  let seq = 0;
  const messages: MessageView[] = [];
  const held: MessageView[] = [];
  let status: MemberStatus = "idle";
  /** Whether Ada is answering on the host, which may differ from what the client was told. */
  let busyOnHost = false;
  let pause: Promise<void> | undefined;
  let answer: (() => void) | undefined;
  let failing = false;
  const rowOf = (
    id: string,
    author: MessageView["author"],
    text: string,
    data: Record<string, unknown> = {},
  ): MessageView => {
    seq += 1;
    return {
      id,
      conversationId: "group",
      seq,
      kind: "message",
      author,
      agentId: author === "agent" ? "ada" : null,
      text,
      thinking: "",
      status: "done",
      revision: 1,
      mentions: [],
      rootMessageId: id,
      replyToId: null,
      data,
      createdAt: 1000,
      updatedAt: 1000,
    };
  };
  function publish() {
    host.state.update((state) => ({
      ...state,
      targets: {
        ...state.targets,
        conversations: list([summary(status)]),
        agents: list([{ id: "ada", name: "Ada" } as AgentView]),
        "conversations.group": {
          sections: {
            timeline: {
              messages: [...messages],
              hasMore: false,
              held: [...held],
            },
            members: [member(status)],
          },
          revisions: {},
          version: seq,
        },
      },
    }));
  }
  /** What Ada is doing, on the host and as the client is told. */
  function setAda(next: MemberStatus, tellClient = true) {
    busyOnHost = next !== "idle";
    if (tellClient) status = next;
    if (!busyOnHost && held.length) messages.push(...held.splice(0));
    publish();
  }
  publish();
  host.address.set({ origin: "http://example.invalid" });
  host.state.update((state) => ({ ...state, status: "open" }));
  host.call = async <T,>(_target: string, action: string, raw?: unknown) => {
    const args = raw as Record<string, unknown> | undefined;
    if (action !== "send") return undefined as T;
    if (pause) await pause;
    if (failing) throw new Error("the host went away");
    const id = String(args!.clientId);
    const row = rowOf(id, "user", String(args!.text), {
      woke: ["ada"],
      ...(busyOnHost ? { held: true } : {}),
    });
    if (busyOnHost) held.push(row);
    else messages.push(row);
    const result = { message: row, replies: [], joined: [], nobody: false };
    // The answer comes before the row, as it may on the wire.
    setTimeout(publish, 0);
    return result as T;
  };
  resumeComposerOutbox(host);
  const layout = (): Layout => (windowSize().width < 600 ? "phone" : "desktop");
  const noop = () => {};
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
          <Button label="Ada starts" onPress={() => setAda("working")} />
          <Button label="Ada ends" onPress={() => setAda("idle")} />
          <Button
            label="Ada ends unseen"
            onPress={() => setAda("idle", false)}
          />
          <Button
            label="Ada starts unseen"
            onPress={() => setAda("working", false)}
          />
          <Button
            label="Hold sends"
            onPress={() => {
              pause = new Promise((resolve) => {
                answer = () => {
                  pause = undefined;
                  resolve();
                };
              });
            }}
          />
          <Button label="Answer" onPress={() => answer?.()} />
          <Button label="Fail sends" onPress={() => (failing = true)} />
          <Button label="Heal sends" onPress={() => (failing = false)} />
          <Button
            label="Disconnect"
            onPress={() =>
              host.state.update((state) => ({
                ...state,
                status: "reconnecting",
              }))
            }
          />
          <Button
            label="Reconnect"
            onPress={() =>
              host.state.update((state) => ({ ...state, status: "open" }))
            }
          />
          <Button
            label="Someone speaks"
            onPress={() => {
              messages.push(rowOf(`other-${seq}`, "agent", "Bo was first"));
              publish();
            }}
          />
        </View>
        <Conversation
          id="group"
          layout={layout()}
          onTask={noop}
          onRelatedTask={noop}
          onAccessLost={noop}
          onRoutines={noop}
          onCloseTask={noop}
        />
      </View>
    </Host.Provider>
  );
}
mount(Fixture);
