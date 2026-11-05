import type { Signal } from "nsh";
import type { ToolBlock } from "./run";
import { computed, Scroll, signal, Text, View } from "nsh";
import { t } from "../../i18n";
import { Header, Page } from "../../ui/Page";
import { Counts } from "./ProcessBox";
import { sentence, stepOf, summarize } from "./steps";
import { exitCodeOf, fullOutputOf, shapeOf, withoutAnsi } from "./tool-shape";

/** Past this many lines a block folds to its first ones, with the rest one press away. */
const FOLD_LINES = 14;
/** A diff shows its hunk's head and five lines (03i). */
const FOLD_PATCH_LINES = 6;

const lineClass = (line: string) =>
  line.startsWith("@@")
    ? "text-muted-foreground"
    : line.startsWith("+")
      ? "text-state-success"
      : line.startsWith("-")
        ? "text-state-error"
        : "text-foreground";

function cleanPatch(patch: string): string[] {
  const lines = patch
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("+++") &&
        !line.startsWith("---") &&
        !line.startsWith("Index:") &&
        !line.startsWith("===") &&
        !line.startsWith("\\"),
    );
  while (lines.at(-1) === "") lines.pop();
  return lines;
}

function FoldToggle(props: {
  count: number;
  limit: number;
  open: Signal<boolean>;
}) {
  return (
    <If when={props.count > props.limit}>
      <View
        role="button"
        onPress={() => props.open.set(!props.open())}
        class="h-10 shrink-0 justify-center px-4 active:opacity-60"
      >
        <Text class="text-md leading-4 text-foreground">
          {props.open()
            ? t("chat.tool.foldLess")
            : t("chat.tool.foldMore", { count: props.count })}
        </Text>
      </View>
    </If>
  );
}

/** A unified diff's lines, each coloured by what happened to it. */
function PatchView(props: { patch: string }) {
  const open = signal(false);
  const lines = computed(() => cleanPatch(props.patch));
  return (
    <>
      <Each of={open() ? lines() : lines().slice(0, FOLD_PATCH_LINES)}>
        {(line) => (
          <View
            selectable
            class={`px-4 ${line().startsWith("@@") ? "pb-2" : ""}`}
          >
            <Text class={`text-sm leading-[20px] ${lineClass(line())}`}>
              {line() === "" ? " " : line()}
            </Text>
          </View>
        )}
      </Each>
      <FoldToggle count={lines().length} limit={FOLD_PATCH_LINES} open={open} />
    </>
  );
}

/** Text that may be long, as printed. */
function Folded(props: { text: string }) {
  const open = signal(false);
  const lines = computed(() => props.text.split("\n"));
  return (
    <>
      <View selectable class="px-4 py-[10px]">
        <Text class="text-sm leading-[20px] text-muted-foreground">
          {open() ? props.text : lines().slice(0, FOLD_LINES).join("\n")}
        </Text>
      </View>
      <FoldToggle count={lines().length} limit={FOLD_LINES} open={open} />
    </>
  );
}

function SectionHead(props: { title: string; aside?: string | undefined }) {
  return (
    <View class="h-11 shrink-0 flex-row items-center gap-2 border-b border-border px-4">
      <Text class="truncate grow basis-0 text-md leading-4 text-foreground">
        {props.title}
      </Text>
      <If when={props.aside !== undefined}>
        <Text class="text-sm leading-4 text-muted-foreground">
          {props.aside}
        </Text>
      </If>
    </View>
  );
}

/** 03i: one tool call, drawn for what it was. */
export function ToolScreen(props: {
  block: ToolBlock;
  lookup: () => ToolBlock | undefined;
}) {
  const block = computed(() => props.lookup() ?? props.block);
  const shape = computed(() => shapeOf(block()));
  const step = computed(() => stepOf(block()));
  const output = () => {
    const text = block().output;
    return text === undefined || text === "" ? undefined : withoutAnsi(text);
  };
  const code = () => exitCodeOf(block());
  const truncated = () => fullOutputOf(block());
  const patches = () => {
    const current = shape();
    return current.kind === "patch" ? current.files : [];
  };
  const title = () => {
    const current = shape();
    if (current.kind === "command") return summarize(current.command);
    return step().text === "" ? sentence(step()) : step().text;
  };
  return (
    <Page>
      <Header
        title={title()}
        right={
          <View class="flex-row items-center gap-2">
            <Counts added={step().added} removed={step().removed} />
          </View>
        }
      />
      <Scroll style={{ flex: 1 }}>
        <View class="py-3">
          <Each of={patches()}>
            {(file) => (
              <>
                <If when={patches().length > 1}>
                  <SectionHead title={file().path} />
                </If>
                <PatchView patch={file().patch} />
              </>
            )}
          </Each>
          <If when={shape().kind === "write"}>
            <Folded text={(shape() as { content?: string }).content ?? ""} />
          </If>
          <If when={shape().kind === "command"}>
            <SectionHead
              title={(shape() as { command?: string }).command ?? ""}
              aside={
                typeof code() === "number" && code() !== 0
                  ? t("chat.tool.exit", { code: code() ?? "?" })
                  : undefined
              }
            />
          </If>
          <If when={shape().kind === "plan"}>
            <View class="gap-1 px-4">
              <Each
                of={
                  (shape() as { items?: { content: string; status: string }[] })
                    .items ?? []
                }
              >
                {(item) => (
                  <Text class="text-sm leading-[20px] text-foreground">
                    {item().status === "completed"
                      ? "■"
                      : item().status === "in_progress"
                        ? "▣"
                        : "□"}{" "}
                    {item().content}
                  </Text>
                )}
              </Each>
            </View>
          </If>
          <If when={shape().kind === "other" && block().input !== undefined}>
            <Folded text={JSON.stringify(block().input, null, 2) ?? ""} />
          </If>
          <If
            when={
              output() !== undefined &&
              (block().status !== "completed" ||
                shape().kind === "command" ||
                shape().kind === "other")
            }
          >
            <Folded text={output() ?? ""} />
          </If>
          <If when={truncated() !== undefined}>
            <View class="min-h-10 justify-center px-4 py-2">
              <Text class="text-sm leading-[18px] text-muted-foreground">
                {truncated() === ""
                  ? t("chat.tool.truncated")
                  : t("chat.tool.truncatedAt", { path: truncated() ?? "" })}
              </Text>
            </View>
          </If>
          <If when={(block().images?.length ?? 0) > 0}>
            <View class="px-4 py-2">
              <Text class="text-sm leading-[18px] text-muted-foreground">
                {t("chat.tool.images", { count: block().images?.length ?? 0 })}
              </Text>
            </View>
          </If>
        </View>
      </Scroll>
    </Page>
  );
}
