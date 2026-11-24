import { mount, Storage, View } from "nsh";
import { Compact, Label, Markdown, Modal } from "../../src/components";
import { TaskTopBar } from "../../src/pages/tasks/top-bar";

// One part of the app (storage `region`): "compact" as a side panel declares it, "regular" as the
// main area is, or "off" (a `Compact when={false}`, a list that is the page on a phone). Inside
// it: a plain label, Markdown with a heading, a table and code, a task's top bar, and with
// storage `dialog` a dialog opened from it.
const markdown = [
  "## Goal",
  "",
  "Pick the faster one.",
  "",
  "| Option | Startup |",
  "|---|---|",
  "| bun | 12 ms |",
  "",
  "```sh",
  "bun run bench",
  "```",
].join("\n");

function Part(props: { dialog: boolean }) {
  return (
    <View style={{ gap: 8, padding: 8 }}>
      <TaskTopBar number={7} inset={12} onBack={() => {}} />
      <Label>Plain label</Label>
      <Markdown value={markdown} />
      <If when={props.dialog}>
        <Modal title="A dialog" onClose={() => {}}>
          <Label>Dialog label</Label>
        </Modal>
      </If>
    </View>
  );
}

function Fixture(props: { region: string; dialog: boolean }) {
  if (props.region === "regular") return <Part dialog={props.dialog} />;
  return (
    <Compact when={props.region === "compact"}>
      <Part dialog={props.dialog} />
    </Compact>
  );
}

void Promise.all([Storage.getItem("region"), Storage.getItem("dialog")]).then(
  ([region, dialog]) =>
    mount(() => (
      <Fixture region={region ?? "regular"} dialog={dialog === "1"} />
    )),
);
