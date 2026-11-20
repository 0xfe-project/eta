import type { ArtifactView } from "@eta/client-contracts";
import type { Signal } from "nsh";
import { View } from "nsh";
import {
  Button,
  Caption,
  colors,
  Empty,
  Field,
  Label,
  row,
} from "../../../components";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
import { messageDate } from "../message-time";
import { ArtifactRow } from "./row";

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
      ? matchingArtifacts().slice(artifactOffset(), artifactOffset() + 10)
      : artifacts().slice(0, 4);
  const newArtifactDay = (entry: ArtifactView, index: number) => {
    if (props.tab !== "Artifacts") return false;
    const previous = artifactsInPanel()[index - 1];
    return (
      !previous ||
      new Date(previous.updatedAt).toDateString() !==
        new Date(entry.updatedAt).toDateString()
    );
  };
  return (
    <View
      style={{
        paddingTop: 12,
        borderBottomWidth: props.tab === "Context" ? 1 : 0,
        borderColor: c().border,
      }}
    >
      <Caption
        text={uiText("artifacts", { length: artifacts().length })}
        style={{ marginHorizontal: 12, marginBottom: 4 }}
      />
      <If when={props.tab === "Artifacts" && artifacts().length}>
        <Field
          label={uiText("searchArtifacts")}
          placeholder={uiText("searchByTitle")}
          style={{ marginHorizontal: 12 }}
          value={artifactSearch()}
          onChange={(value) => {
            artifactSearch.set(value);
            artifactOffset.set(0);
          }}
        />
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
          <Empty
            icon="panel"
            title={
              host.state().missing.artifacts
                ? uiText("artifactLoadError")
                : host.state().targets.artifacts
                  ? uiText("noArtifactsYet")
                  : uiText("artifactsLoading")
            }
            description={
              host.state().missing.artifacts
                ? uiText("theHostDidNotRespondIn")
                : host.state().targets.artifacts
                  ? uiText("artifactsEmptyHelp")
                  : undefined
            }
          >
            <If when={host.state().missing.artifacts}>
              <Button
                label={uiText("retry")}
                icon="refresh"
                onPress={props.reload}
              />
            </If>
          </Empty>
        </If>
      </If>
      <Each of={artifactsInPanel()} key={(artifact) => artifact.id}>
        {(artifact, index) => (
          <>
            <If when={newArtifactDay(artifact(), index())}>
              <Label
                size={11}
                tone="muted"
                style={{ paddingHorizontal: 10, paddingTop: 9 }}
              >
                {messageDate(artifact().updatedAt)}
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
      <If when={props.tab === "Artifacts" && matchingArtifacts().length > 10}>
        <View
          style={{
            ...row,
            justifyContent: "flex-end",
            gap: 6,
            padding: 12,
          }}
        >
          <Button
            label={uiText("previous")}
            disabled={!artifactOffset()}
            onPress={() =>
              artifactOffset.update((value) => Math.max(0, value - 10))
            }
          />
          <Button
            label={uiText("next")}
            disabled={artifactOffset() + 10 >= matchingArtifacts().length}
            onPress={() => artifactOffset.update((value) => value + 10)}
          />
        </View>
      </If>
    </View>
  );
}
