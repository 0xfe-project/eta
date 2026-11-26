import type { MemberView, MessageView } from "@eta/client-contracts";
import { mount, signal, Text, View, windowSize } from "nsh";
import { Button } from "../src/components";
import { NotificationHost } from "../src/components/notifications";
import { Composer } from "../src/pages/chat/composer";
import { resumeComposerOutbox } from "../src/pages/chat/composer-draft";
import { createHost, Host } from "../src/services/host";

function Fixture() {
  const host = createHost();
  host.address.set({ origin: "http://example.invalid" });
  host.state.update((state) => ({ ...state, status: "open" }));
  const group = signal("alpha");
  const result = signal("");
  const held = signal<MessageView[]>([]);
  function queueOne() {
    held.set([
      {
        id: "held",
        conversationId: group(),
        seq: 1,
        kind: "message",
        author: "user",
        agentId: null,
        text: "earlier",
        thinking: "",
        status: "done",
        revision: 1,
        mentions: ["Ada"],
        rootMessageId: null,
        replyToId: null,
        data: { woke: ["Ada"] },
        createdAt: 0,
        updatedAt: 0,
      },
    ]);
  }
  // A lane took the queued message before the user pressed anything.
  let handedOn = false;
  const failed = new Set<string>();
  let finishUpload: (() => void) | undefined;
  const uploadFailures = new Set<string>();
  const resultBlocks = signal("");
  const uploadNames = new Map<string, string>();
  const resultFiles = signal("");
  const quote = signal<{ conversationId: string; text: string }>();
  Object.assign(host, {
    agent: (id: string) => ({ id, name: id }),
    tasks: () => [
      {
        number: 1,
        title: "Review",
        status: "todo",
        conversationId: "alpha",
        updatedAt: 1,
      },
    ],
    async call(_target: string, action: string, args: Record<string, unknown>) {
      if (action === "files") return { files: ["README.md"] };
      if (action === "attach") {
        if (args.name === "composer.test.tsx")
          await new Promise<void>((resolve) => {
            finishUpload = resolve;
          });
        if (
          args.name === "onboard.jpg" &&
          !uploadFailures.has(String(args.name))
        ) {
          uploadFailures.add(String(args.name));
          throw new Error("upload interrupted");
        }
        uploadNames.set(String(args.uploadId), String(args.name));
        return {
          attachment: {
            id: args.uploadId,
            name: args.name,
            size: 1,
            contentType: args.contentType,
          },
        };
      }
      if (action === "send") {
        if (args.text === "retry" && !failed.has(String(args.clientId))) {
          failed.add(String(args.clientId));
          result.set("delivery failed");
          throw new Error("delivery failed");
        }
        resultBlocks.set(JSON.stringify(args.blocks));
        const sentFiles = (args.attachments as string[] | undefined) ?? [];
        resultFiles.set(
          sentFiles.length
            ? `attachments ${sentFiles.map((id) => uploadNames.get(id)).join(",")}`
            : "",
        );
        result.set(
          `sent ${JSON.stringify([
            args.conversationId,
            args.text,
            args.mode,
            args.attachments,
          ])}`,
        );
        return { message: {} };
      }
      if (action === "recall") {
        held.set([]);
        return { recalled: !handedOn };
      }
      if (action === "steerHeld") throw new Error("lane closed");
      if (action === "stop")
        result.set(
          args.messageId
            ? `stopped ${args.conversationId}/${args.messageId}`
            : `stopped ${args.conversationId}`,
        );
      return {};
    },
  });
  resumeComposerOutbox(host);
  const members: MemberView[] = [
    { agentId: "Ada", sessionId: null, lastSeq: 0, status: "working" },
  ];
  if (windowSize().width === 640)
    for (const id of ["Bo", "Captain", "Cyrus", "Dana"])
      members.push({
        agentId: id,
        sessionId: null,
        lastSeq: 0,
        status: "idle",
      });
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1, justifyContent: "center" }}>
        <Button
          label="Switch"
          onPress={() => group.set(group() === "alpha" ? "beta" : "alpha")}
        />
        <Button label="Finish upload" onPress={() => finishUpload?.()} />
        <Button label="Queue one" onPress={queueOne} />
        <Button
          label="Hand it on"
          onPress={() => {
            handedOn = true;
          }}
        />
        <Button
          label="Quote"
          onPress={() =>
            quote.set({
              conversationId: group(),
              text: " Line one\n\nLine two \n",
            })
          }
        />
        <Each of={[group()]}>
          {(id) => (
            <Composer
              id={id()}
              name={id()}
              members={members.map((member) =>
                member.status === "working"
                  ? { ...member, activeReplyId: `${id()}-${member.agentId}` }
                  : member,
              )}
              group
              phone={windowSize().width < 600}
              tablet={windowSize().width === 640}
              writing
              projectId="project"
              held={held()}
              quote={quote()}
            />
          )}
        </Each>
        <Text>{result()}</Text>
        <Text>{resultBlocks()}</Text>
        <Text>{resultFiles()}</Text>
        <NotificationHost />
      </View>
    </Host.Provider>
  );
}
mount(Fixture);
