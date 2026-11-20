import type { ArtifactView } from "@eta/client-contracts";
import type { Signal, ViewRef } from "nsh";
import { keymap, View } from "nsh";
import {
  Button,
  Caption,
  colors,
  Empty,
  Field,
  Icon,
  Label,
  ListSkeleton,
  row,
} from "../../../components";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
import { ArtifactRow } from "./row";

const pageSize = 15;

export function ConversationArtifacts(props: {
  conversationId: string;
  tab: string;
  search: Signal<string>;
  offset: Signal<number>;
  phone: boolean;
  onOpen: (artifact: ArtifactView) => void;
  onTask: (id: string) => void;
  reload: () => void;
}) {
  const c = colors();
  const host = useHost();
  const artifactSearch = props.search;
  const artifactOffset = props.offset;
  const artifacts = () =>
    host
      .artifacts()
      .filter((entry) => entry.conversationId === props.conversationId);
  const matchingArtifacts = () =>
    artifacts().filter((item) =>
      item.title.toLowerCase().includes(artifactSearch().trim().toLowerCase()),
    );
  const artifactsInPanel = () =>
    props.tab === "Artifacts"
      ? matchingArtifacts().slice(artifactOffset(), artifactOffset() + pageSize)
      : artifacts().slice(0, 4);
  const newArtifactDay = (entry: ArtifactView, index: number) => {
    if (props.tab !== "Artifacts") return false;
    const previous = artifactsInPanel()[index - 1];
    return (
      !previous || dayGroup(previous.updatedAt) !== dayGroup(entry.updatedAt)
    );
  };
  const pages = () => Math.ceil(matchingArtifacts().length / pageSize);
  const page = () => Math.floor(artifactOffset() / pageSize);
  let searchInput: ViewRef | undefined;
  keymap.bind(
    "/",
    () => {
      if (props.tab === "Artifacts") searchInput?.focus();
    },
    { when: "notEditing" },
  );
  return (
    <View
      style={{
        paddingTop: 12,
        borderBottomWidth: props.tab === "Context" ? 1 : 0,
        borderColor: c().border,
      }}
    >
      <If when={props.tab !== "Artifacts"}>
        <Caption
          text={uiText("artifacts", { length: artifacts().length })}
          style={{ marginHorizontal: 12, marginBottom: 4 }}
        />
      </If>
      <If when={props.tab === "Artifacts" && artifacts().length}>
        <View
          style={{
            padding: 10,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <View
            style={{
              ...row,
              height: 26,
              gap: 8,
              paddingHorizontal: 8,
              borderWidth: 1,
              borderColor: c().border,
              backgroundColor: c().canvas,
            }}
          >
            <Icon name="search" size={12} tone="muted" />
            <Field
              label={uiText("searchArtifacts")}
              placeholder={uiText("searchTitles")}
              inputRef={(node) => {
                searchInput = node;
              }}
              style={{
                flex: 1,
                height: 24,
                paddingHorizontal: 0,
                paddingVertical: 4,
                borderWidth: 0,
                fontSize: 11,
                lineHeight: 16,
              }}
              value={artifactSearch()}
              onChange={(value) => {
                artifactSearch.set(value);
                artifactOffset.set(0);
              }}
            />
            <View
              style={{
                paddingHorizontal: 4,
                borderWidth: 1,
                borderColor: c().border,
              }}
            >
              <Label size={10} line={14} tone="muted">
                /
              </Label>
            </View>
          </View>
        </View>
        <If when={!matchingArtifacts().length}>
          <Label
            size={12}
            tone="muted"
            style={{ marginHorizontal: 12, marginTop: 4 }}
          >
            {uiText("noMatchingArtifacts")}
          </Label>
        </If>
      </If>
      <If when={!artifacts().length}>
        <If
          when={props.tab === "Artifacts"}
          else={
            <Label
              size={12}
              tone="muted"
              style={{ marginHorizontal: 12, marginBottom: 12 }}
            >
              {uiText("noArtifactsYet")}
            </Label>
          }
        >
          <If
            when={
              host.state().targets.artifacts || host.state().missing.artifacts
            }
            else={<ListSkeleton label={uiText("artifactsLoading")} />}
          >
            <Empty
              icon={host.state().missing.artifacts ? "warning" : "appWindow"}
              iconSize={32}
              iconTone={host.state().missing.artifacts ? "red" : "muted"}
              style={{ paddingVertical: 40 }}
              title={
                host.state().missing.artifacts
                  ? uiText("artifactLoadError")
                  : uiText("noArtifactsYet")
              }
              description={
                host.state().missing.artifacts
                  ? uiText("theHostDidNotRespondIn")
                  : uiText("artifactsEmptyHelp")
              }
            >
              <If when={host.state().missing.artifacts}>
                <Button
                  label={uiText("retry")}
                  icon="refresh"
                  size={28}
                  style={{ marginTop: 4 }}
                  onPress={props.reload}
                />
              </If>
            </Empty>
          </If>
        </If>
      </If>
      <Each of={artifactsInPanel()} key={(artifact) => artifact.id}>
        {(artifact, index) => (
          <>
            <If when={newArtifactDay(artifact(), index())}>
              <Label
                size={11}
                line={16}
                tone="muted"
                style={{
                  paddingHorizontal: 10,
                  paddingTop: 14,
                  paddingBottom: 6,
                }}
              >
                {uiText(dayGroup(artifact().updatedAt))}
              </Label>
            </If>
            <ArtifactRow
              artifact={artifact()}
              placement={props.tab === "Artifacts" ? "list" : "context"}
              phone={props.phone}
              onPress={() => props.onOpen(artifact())}
              onTask={props.onTask}
            />
          </>
        )}
      </Each>
      <If when={props.tab === "Artifacts" && pages() > 1}>
        <View
          style={{
            ...row,
            height: 40,
            justifyContent: "space-between",
            paddingHorizontal: 10,
          }}
        >
          <Label size={10} line={14} tone="muted">
            {`${artifactOffset() + 1}-${Math.min(
              artifactOffset() + pageSize,
              matchingArtifacts().length,
            )} / ${matchingArtifacts().length}`}
          </Label>
          <View style={{ ...row, gap: 10 }}>
            <PageButton
              label="‹"
              accessibilityLabel={uiText("previous")}
              disabled={!page()}
              onPress={() => artifactOffset.set((page() - 1) * pageSize)}
            />
            <Each of={pageNumbers(page(), pages())}>
              {(number) => (
                <If
                  when={number() >= 0}
                  else={
                    <Label size={10} line={14} tone="muted">
                      …
                    </Label>
                  }
                >
                  <PageButton
                    label={String(number() + 1)}
                    selected={number() === page()}
                    onPress={() => artifactOffset.set(number() * pageSize)}
                  />
                </If>
              )}
            </Each>
            <PageButton
              label="›"
              accessibilityLabel={uiText("next")}
              disabled={page() >= pages() - 1}
              onPress={() => artifactOffset.set((page() + 1) * pageSize)}
            />
          </View>
        </View>
      </If>
    </View>
  );
}

/** Today, Yesterday or Earlier: the Artifacts tab's date groups. */
function dayGroup(at: number) {
  const day = new Date(at).toDateString();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === new Date().toDateString()) return "todayDate" as const;
  if (day === yesterday.toDateString()) return "yesterdayDate" as const;
  return "earlierDate" as const;
}

/** Page indexes to show, with -1 for a gap: all of up to seven, else the ends and the current. */
function pageNumbers(current: number, count: number) {
  if (count <= 7) return Array.from({ length: count }, (_, index) => index);
  const shown = [...new Set([0, current - 1, current, current + 1, count - 1])]
    .filter((index) => index >= 0 && index < count)
    .sort((a, b) => a - b);
  return shown.flatMap((index, position) =>
    position && index - shown[position - 1]! > 1 ? [-1, index] : [index],
  );
}

function PageButton(props: {
  label: string;
  accessibilityLabel?: string;
  selected?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const c = colors();
  return (
    <View
      role="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{
        selected: props.selected,
        disabled: props.disabled ?? false,
      }}
      onPress={() => {
        if (!props.disabled) props.onPress();
      }}
      style={{
        ...row,
        justifyContent: "center",
        height: props.selected ? 22 : undefined,
        width: props.selected ? 20 : undefined,
        borderWidth: props.selected ? 1 : 0,
        borderColor: c().ink,
        opacity: props.disabled ? 0.45 : 1,
        cursor: props.disabled ? "default" : "pointer",
      }}
    >
      <Label size={10} line={14} tone={props.selected ? "ink" : "muted"}>
        {props.label}
      </Label>
    </View>
  );
}
