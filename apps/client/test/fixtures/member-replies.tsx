import type { MemberView } from "@eta/client-contracts";
import { mount, signal, Text, View, windowSize } from "nsh";
import { Button } from "../../src/components";
import { Composer } from "../../src/pages/chat/composer";
import { createHost, Host } from "../../src/services/host";

function Fixture() {
  const host = createHost();
  host.address.set({ origin: "http://example.invalid" });
  host.state.update((state) => ({
    ...state,
    status: "open",
    targets: {
      agents: {
        version: 1,
        revisions: {},
        sections: { list: ["Ada", "Lin"].map((name) => ({ id: name, name })) },
      },
    },
  }));
  const ada = signal<string | undefined>("ada-1");
  const calls = signal<string[]>([]);
  let resolveStop: (() => void) | undefined;
  host.call = async <T,>(target: string, action: string, args?: unknown) => {
    calls.update((log) => [
      ...log,
      `${target}.${action} ${JSON.stringify(args)}`,
    ]);
    await new Promise<void>((resolve) => {
      resolveStop = resolve;
    });
    return { stopped: [] } as T;
  };
  function member(agentId: string, activeReplyId?: string): MemberView {
    return {
      agentId,
      sessionId: null,
      lastSeq: 1,
      status: activeReplyId ? "working" : "idle",
      ...(activeReplyId ? { activeReplyId } : {}),
    };
  }
  return (
    <Host.Provider value={host}>
      <View>
        <Composer
          id="group"
          name="Group"
          group
          tablet={false}
          writing
          phone={windowSize().width < 600}
          members={[member("Ada", ada()), member("Lin", "lin-1")]}
          held={[]}
        />
        <Button label="Finish Ada" onPress={() => ada.set(undefined)} />
        <Button label="Another Ada reply" onPress={() => ada.set("ada-2")} />
        <Button label="Deliver stop response" onPress={() => resolveStop?.()} />
        <Text>{calls().join("\n")}</Text>
      </View>
    </Host.Provider>
  );
}
mount(Fixture);
