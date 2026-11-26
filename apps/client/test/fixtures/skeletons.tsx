import { mount, signal, View } from "nsh";
import {
  Button,
  DetailSkeleton,
  Label,
  ListSkeleton,
  palette,
  Palette,
  SafeArea,
  Screen,
  SkeletonReveal,
} from "../../src/components";
import { settled } from "../../src/components/pending";
import { space } from "../../src/components/tokens";
import { Widget } from "../../src/pages/chat/widgets/widget";
import { PersonaStep } from "../../src/pages/onboarding/persona-step";
import { TaskDetail } from "../../src/pages/tasks/task-detail";
import { Host } from "../../src/services/host";

function Fixture() {
  const c = () => palette("light");
  const mode = signal<"list" | "onboarding" | "widget" | "task">("list");

  // List + SkeletonReveal state
  const listReady = signal(false);
  const listSettled = settled(listReady);

  // Onboarding PersonaStep state
  const personaLoading = signal(true);
  const personaMissing = signal(false);
  const personaRetries = signal(0);

  // TaskDetail missing state
  const taskMissing = signal(true);
  const taskClosed = signal(0);

  const stubHost = {
    state: () => ({
      status: "open" as const,
      targets: {},
      missing: taskMissing() ? { "tasks.t-missing": true } : {},
      ops: [],
      error: "",
    }),
    disconnected: () => false,
    paused: () => false,
    section: () => undefined,
    list: () => [],
    tasks: () => [],
    agents: () => [],
    agent: () => undefined,
    artifacts: () => [],
    conversation: () => undefined,
    address: () => ({ origin: "http://localhost:3000" }),
    can: () => false,
    subscriptionWire: () => undefined,
    watch: () => () => {},
    subscribe: () => () => {},
    follow: () => () => {},
    wake: () => personaRetries.update((n) => n + 1),
    retry: () => personaRetries.update((n) => n + 1),
    reconnect: () => personaRetries.update((n) => n + 1),
    action: async <T,>(fn: () => Promise<T>) => fn(),
    call: async () => ({}),
    optimistic: async <T,>(
      _id: string,
      _patch: Record<string, unknown>,
      fn: () => Promise<T>,
    ) => fn(),
  } as unknown as ReturnType<typeof Host>;

  return (
    <Host.Provider value={stubHost}>
      <Palette.Provider value={c}>
        <Screen.Provider value={() => "desktop"}>
          <SafeArea style={{ backgroundColor: c().canvas, padding: space[16] }}>
            <View style={{ flexDirection: "row", gap: space[8] }}>
              <Button label="Tab list" onPress={() => mode.set("list")} />
              <Button
                label="Tab onboarding"
                onPress={() => mode.set("onboarding")}
              />
              <Button label="Tab widget" onPress={() => mode.set("widget")} />
              <Button label="Tab task" onPress={() => mode.set("task")} />
            </View>

            <If when={mode() === "list"}>
              <View style={{ gap: space[8], paddingTop: space[12] }}>
                <Button
                  label="Mark list ready"
                  onPress={() => listReady.set(true)}
                />
                <If
                  when={listSettled()}
                  else={<ListSkeleton label="Loading items…" />}
                >
                  <View testID="real-rows">
                    <Each of={["Alpha", "Beta", "Gamma"]}>
                      {(item, index) => (
                        <SkeletonReveal index={index()}>
                          <Label>{item()}</Label>
                        </SkeletonReveal>
                      )}
                    </Each>
                  </View>
                </If>
                <DetailSkeleton label="Detail loading…" />
              </View>
            </If>

            <If when={mode() === "onboarding"}>
              <View style={{ paddingTop: space[12] }}>
                <Button
                  label="Fail personas"
                  onPress={() => {
                    personaLoading.set(false);
                    personaMissing.set(true);
                  }}
                />
                <Label>{`persona-retries:${personaRetries()}`}</Label>
                <PersonaStep
                  phone={false}
                  cards={[]}
                  loading={personaLoading()}
                  missing={personaMissing()}
                  missingReason="Offline"
                  working={false}
                  activeCard=""
                  installedCount={0}
                  total={0}
                  installed={() => false}
                  installedHere={() => false}
                  selected={() => true}
                  onToggle={() => {}}
                  onRetry={() => personaRetries.update((n) => n + 1)}
                />
              </View>
            </If>

            <If when={mode() === "widget"}>
              <View testID="widget-wrap" style={{ paddingTop: space[12] }}>
                <Widget
                  value={{
                    id: "w1",
                    title: "Revenue chart",
                    code: "<div>Chart</div>",
                    streaming: false,
                  }}
                />
              </View>
            </If>

            <If when={mode() === "task"}>
              <View style={{ flex: 1, paddingTop: space[12] }}>
                <Label>{`task-closed:${taskClosed()}`}</Label>
                <TaskDetail
                  id="t-missing"
                  layout="desktop"
                  onClose={() => taskClosed.update((n) => n + 1)}
                  onTask={() => {}}
                />
              </View>
            </If>
          </SafeArea>
        </Screen.Provider>
      </Palette.Provider>
    </Host.Provider>
  );
}

mount(Fixture);
