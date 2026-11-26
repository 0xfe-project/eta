import type { ProgressHandle } from "../../src/components/progress-notification";
import { mount, signal, View } from "nsh";
import {
  Button,
  Label,
  palette,
  Palette,
  SafeArea,
  Screen,
} from "../../src/components";
import { NotificationHost } from "../../src/components/notifications";
import { settled, shownWhile } from "../../src/components/pending";
import { startProgress } from "../../src/components/progress-notification";
import { SpinningIcon } from "../../src/components/spinner";
import { showToast } from "../../src/components/toast";
import { icon, space } from "../../src/components/tokens";

function Fixture() {
  const c = () => palette("light");
  const busy = signal(false);
  const ready = signal(true);
  const spinRunning = signal(false);
  const events = signal<string[]>([]);
  const waiting = shownWhile(busy);
  const isSettled = settled(ready);
  let activeProgress: ProgressHandle | undefined;

  const log = (entry: string) => events.update((all) => [...all, entry]);

  return (
    <Palette.Provider value={c}>
      <Screen.Provider value={() => "desktop"}>
        <SafeArea style={{ backgroundColor: c().canvas, padding: space[16] }}>
          <View style={{ gap: space[8] }}>
            {/* Pending / settled timing */}
            <View testID="pending-state">
              <Label>{waiting() ? "pending:shown" : "pending:hidden"}</Label>
              <Label>
                {isSettled() ? "region:settled" : "region:skeleton"}
              </Label>
            </View>
            <Button
              label="Start busy"
              onPress={() => {
                busy.set(true);
                ready.set(false);
              }}
            />
            <Button
              label="Stop busy"
              onPress={() => {
                busy.set(false);
                ready.set(true);
              }}
            />

            {/* SpinningIcon */}
            <View testID="spin-host">
              <SpinningIcon
                name="refresh"
                running={spinRunning()}
                size={icon.md}
              />
            </View>
            <Button label="Start spin" onPress={() => spinRunning.set(true)} />
            <Button label="Stop spin" onPress={() => spinRunning.set(false)} />

            {/* Toasts */}
            <Button
              label="Short toast"
              onPress={() => showToast({ title: "Copied" })}
            />
            <Button
              label="Undo toast"
              onPress={() =>
                showToast({
                  title: "Archived task",
                  action: { label: "Undo", onPress: () => log("undo") },
                })
              }
            />
            <Button
              label="Custom toast"
              onPress={() => showToast({ title: "Quick note", duration: 1200 })}
            />

            {/* ProgressNotification */}
            <Button
              label="Start export"
              onPress={() => {
                activeProgress = startProgress({
                  id: "export",
                  title: "Exporting PDF",
                  progress: 0.25,
                  onCancel: () => log("export:cancelled"),
                });
              }}
            />
            <Button
              label="Advance export"
              onPress={() => {
                activeProgress?.update({
                  progress: 0.5,
                  count: { completed: 5, total: 10 },
                });
              }}
            />
            <Button
              label="Finish export"
              onPress={() => {
                activeProgress?.complete({
                  title: "PDF exported",
                  detail: "report.pdf",
                  onOpen: () => log("export:opened"),
                });
              }}
            />
            <Button
              label="Start indeterminate"
              onPress={() => {
                activeProgress = startProgress({
                  id: "clone",
                  title: "Cloning repository",
                  onCancel: () => log("clone:cancelled"),
                });
              }}
            />
            <Button
              label="Fail progress"
              onPress={() => {
                activeProgress?.fail({
                  title: "Export failed",
                  detail: "Disk full",
                  onRetry: () => log("export:retried"),
                });
              }}
            />

            <View testID="event-log">
              <Label>{events().join(",") || "events:none"}</Label>
            </View>
          </View>
          <NotificationHost />
        </SafeArea>
      </Screen.Provider>
    </Palette.Provider>
  );
}

mount(Fixture);
