import type {
  ArtifactResults,
  ArtifactView,
  AttachmentView,
  CaptainOperationView,
  ConversationInfo,
  ConversationResults,
  EmailProposalView,
  HistoryResult,
  InboxResponse,
  InteractionView,
  MemberView,
  MessageView,
  RoutineSummary,
  RunBlock,
  TimelineSection,
  TranscriptSection,
  ViewCore,
} from "@eta/client-contracts";
import type { ListRef, WebViewRef } from "nsh";
import type { CaptureArtifactPdf } from "./artifact-pdf-preview";
import type { Layout } from "./ui";
import {
  ATTACH_CHUNK_BYTES,
  captainProposalOf,
  commandOf,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  publishedRefs,
  runBlocks,
  runFromOf,
  savedSteps,
} from "@eta/client-contracts";
import {
  cleanup,
  Clipboard,
  computed,
  effect,
  List,
  openUrl,
  Picker,
  platform,
  Scroll,
  signal,
  View,
  WebView,
  windowSize,
} from "nsh";
import { Checkbox, Dialog, Menu, MenuItem, MenuSeparator } from "nsh/base";
import { createArtifactFileSaver } from "./artifact-file";
import {
  ArtifactPdfPreview,
  ArtifactPdfResourcesError,
} from "./artifact-pdf-preview";
import { ConversationActions } from "./conversation-actions";
import { clock, follow, relativeTime, useHost } from "./host";
import { indexInserts, InsertMessage } from "./insert-message";
import { formatLocale, uiText } from "./locale";
import { MemberRun } from "./member-run";
import { MemberStepsLedger, MemberStepsToggle } from "./member-steps";
import { ModelSelect } from "./models";
import { AgentFace } from "./shell";
import {
  TaskDetail,
  TaskGlyph,
  taskNeedsAttention,
  TaskStatus,
  TaskSummary,
} from "./tasks";

import {
  ActionItem,
  ActionMenu,
  Button,
  Caption,
  colors,
  Empty,
  Field,
  fill,
  grow,
  Header,
  Icon,
  Label,
  Markdown,
  Modal,
  row,
  sizes,
} from "./ui";
import { Widget, widgetFrom } from "./widget";
import { EmailProposal } from "./workspace";

type PanelTab = "Context" | "Tasks" | "Pending" | "Artifacts";
const panelTabs = [
  ["Context", "context", "chatContext"],
  ["Tasks", "tasks", "tasks2"],
  ["Pending", "bell", "pending"],
  ["Artifacts", "panel", "chatArtifacts"],
] as const;
const activeReply = (status: string) =>
  ["queued", "working", "stopping", "waiting_for_input"].includes(status);
const memberStates: Record<string, Parameters<typeof uiText>[0]> = {
  working: "memberWorking",
  running: "running",
  waiting_for_input: "waitingForInput",
  queued: "queued",
  stopping: "stopping",
};
function memberStatus(status: string) {
  if (status === "idle") return uiText("idle");
  if (formatLocale() === "zh-CN" && Object.hasOwn(memberStates, status))
    return uiText(memberStates[status]!);
  return status.replaceAll("_", " ");
}

function messageDate(at: number) {
  const day = new Date(at);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const date = day.toDateString();
  if (date === today.toDateString()) return uiText("todayDate");
  if (date === yesterday.toDateString()) return uiText("yesterdayDate");
  return day.toLocaleDateString(formatLocale(), {
    month: "short",
    day: "numeric",
  });
}

function messageTime(at: number, phone: boolean) {
  return phone ? clock(at) : `${messageDate(at)} ${clock(at)}`;
}

function Question(props: {
  item: InteractionView;
  onDone?: () => void;
  onConversation?: () => void;
  sheet?: boolean;
}) {
  const host = useHost();
  const c = colors();
  const selected = signal<string[]>([]);
  const reply = signal("");
  const busy = signal(false);
  const conversation = () =>
    host.conversations().find((item) => item.id === props.item.conversationId);
  async function answer(response: InboxResponse) {
    if (busy()) return;
    busy.set(true);
    const result = await host.action(() =>
      host.call("inbox", "answer", { id: props.item.id, response }),
    );
    busy.set(false);
    if (result) props.onDone?.();
  }
  function toggle(option: string) {
    selected.update((items) =>
      items.includes(option)
        ? items.filter((item) => item !== option)
        : props.item.multi
          ? [...items, option]
          : [option],
    );
  }
  function submit() {
    return answer(
      selected().length
        ? {
            kind: "selection",
            selections: selected(),
            comment: reply().trim() || undefined,
          }
        : { kind: "freeform", text: reply().trim() },
    );
  }
  return (
    <View
      style={{
        ...(props.sheet ? grow : {}),
        borderWidth: props.sheet ? 0 : 1,
        borderColor: c().border,
        backgroundColor: c().canvas,
      }}
    >
      <Scroll style={props.sheet ? grow : undefined} scrollbar={false}>
        <View style={{ padding: props.sheet ? 16 : 12, gap: 8 }}>
          <If when={props.sheet} else={<Caption text={uiText("question")} />}>
            <Label size={11} tone="muted">
              {[conversation()?.name, relativeTime(props.item.createdAt)]
                .filter(Boolean)
                .join(" · ")}
            </Label>
          </If>
          <Label size={props.sheet ? 16 : 14}>{props.item.prompt}</Label>
          <View
            style={
              props.sheet ? { gap: 8 } : { ...row, flexWrap: "wrap", gap: 6 }
            }
          >
            <Each of={props.item.options}>
              {(option) => (
                <Button
                  label={option()}
                  selected={selected().includes(option())}
                  tone={
                    props.sheet && selected().includes(option())
                      ? "primary"
                      : "plain"
                  }
                  end={
                    props.sheet && selected().includes(option())
                      ? "check"
                      : undefined
                  }
                  size={props.sheet ? 44 : undefined}
                  labelSize={props.sheet ? 14 : undefined}
                  style={
                    props.sheet
                      ? {
                          width: "100%",
                          justifyContent: "space-between",
                          paddingHorizontal: 12,
                        }
                      : undefined
                  }
                  onPress={() => toggle(option())}
                />
              )}
            </Each>
          </View>
          <Field
            label={uiText("yourAnswer")}
            value={reply()}
            placeholder={
              props.sheet
                ? uiText("orWriteYourOwnAnswer")
                : uiText("yourAnswerProgress")
            }
            onChange={reply.set}
            style={props.sheet ? { height: 43 } : undefined}
          />
        </View>
      </Scroll>
      <View
        style={{
          ...row,
          justifyContent: "flex-end",
          gap: 8,
          padding: props.sheet ? 16 : 12,
          borderTopWidth: props.sheet ? 1 : 0,
          borderColor: c().border,
        }}
      >
        <If when={props.sheet && props.onConversation}>
          <Button
            label={uiText("openConversation")}
            tone="ghost"
            onPress={() => props.onConversation?.()}
          />
          <View style={{ flex: 1 }} />
        </If>
        <If when={!props.sheet}>
          <Button
            label={uiText("skip")}
            disabled={busy()}
            onPress={() => void answer({ kind: "none" })}
          />
        </If>
        <Button
          label={props.sheet ? uiText("sendAnswer") : uiText("answer")}
          tone="primary"
          size={props.sheet ? 36 : undefined}
          disabled={busy() || (!selected().length && !reply().trim())}
          onPress={() => void submit()}
        />
      </View>
    </View>
  );
}

function Proposal(props: {
  operation: CaptainOperationView;
  sheet?: boolean;
  onConversation?: () => void;
}) {
  const host = useHost();
  const c = colors();
  const working = signal(false);
  const title = () =>
    String(
      props.operation.payload.name ??
        props.operation.payload.title ??
        props.operation.kind.replaceAll("_", " "),
    );
  async function decide(decision: "approve" | "reject") {
    if (working()) return;
    working.set(true);
    await host.action(() =>
      host.call("captain", "decideOperation", {
        operationId: props.operation.id,
        decision,
      }),
    );
    working.set(false);
  }
  return (
    <View
      style={{
        ...(props.sheet ? grow : {}),
        borderWidth: props.sheet ? 0 : 1,
        borderColor: c().border,
        padding: props.sheet ? 16 : 10,
        gap: props.sheet ? 10 : 5,
      }}
    >
      <Caption text={props.operation.kind.replaceAll("_", " ")} />
      <Label weight={600} size={props.sheet ? 16 : 14}>
        {title()}
      </Label>
      <Each
        of={Object.entries(props.operation.payload).filter(
          ([key, value]) =>
            !["name", "title"].includes(key) &&
            !key.endsWith("Id") &&
            typeof value === "string",
        )}
      >
        {(detail) => (
          <Label size={12} tone="muted">
            {String(detail()[1])}
          </Label>
        )}
      </Each>
      <If
        when={
          props.operation.requiresApproval &&
          props.operation.status === "pending"
        }
        else={
          <Label size={12} tone="muted">
            {props.operation.error ?? props.operation.status}
          </Label>
        }
      >
        <If when={props.sheet}>
          <View style={{ flex: 1 }} />
        </If>
        <View style={{ ...row, justifyContent: "flex-end", gap: 6 }}>
          <If when={props.sheet && props.onConversation}>
            <Button
              label={uiText("openConversation")}
              tone="ghost"
              onPress={() => props.onConversation?.()}
            />
            <View style={{ flex: 1 }} />
          </If>
          <Button
            label={uiText("reject")}
            disabled={working()}
            onPress={() => void decide("reject")}
          />
          <Button
            label={uiText("approve")}
            tone="primary"
            disabled={working()}
            onPress={() => void decide("approve")}
          />
        </View>
      </If>
    </View>
  );
}

function ArtifactRow(props: {
  artifact: ArtifactView;
  version?: number;
  placement?: "context" | "list";
  phone?: boolean;
  onPress: () => void;
  onTask?: (id: string) => void;
}) {
  const host = useHost();
  const c = colors();
  const list = () => props.placement === "list";
  const version = () => props.version ?? props.artifact.versions[0]?.number;
  const title = () =>
    uiText("version", {
      title: props.artifact.title,
      value2: version() ?? "",
    });
  const publisher = () =>
    host.agent(props.artifact.publisherAgentId)?.name ??
    uiText("artifactPublisherUnavailable");
  const timestamp = () =>
    list()
      ? clock(props.artifact.updatedAt)
      : messageTime(props.artifact.updatedAt, false);
  const metadata = () =>
    [publisher(), version() ? `v${version()}` : undefined, timestamp()]
      .filter(Boolean)
      .join(" · ");
  const linkedTask = () =>
    props.onTask && props.artifact.taskId
      ? host.tasks().find((task) => task.id === props.artifact.taskId)
      : undefined;
  return (
    <View
      style={{
        position: "relative",
        borderBottomWidth: list() ? 1 : 0,
        borderColor: c().border,
      }}
      hoverStyle={{ backgroundColor: c().selected }}
    >
      <View
        role="button"
        accessibilityLabel={title()}
        accessibilityHint={props.placement ? metadata() : undefined}
        onPress={props.onPress}
        focusVisibleStyle={{
          outlineWidth: 1,
          outlineColor: c().blue,
          outlineOffset: -1,
        }}
        style={{ ...fill, cursor: "pointer" }}
      />
      <View
        style={{
          ...row,
          alignItems: "flex-start",
          gap: list() ? 10 : 8,
          minHeight: props.phone ? 44 : undefined,
          paddingHorizontal: list() ? 10 : props.placement ? 12 : 0,
          paddingTop: list() ? 10 : props.placement ? 2 : 5,
          paddingBottom: props.placement ? 10 : 5,
          pointerEvents: "box-none",
        }}
      >
        <View
          style={{
            marginTop: list() ? 3 : 2,
            flexShrink: 0,
            pointerEvents: "none",
          }}
        >
          <Icon name="artifact" size={12} />
        </View>
        <View
          style={{ ...grow, gap: list() ? 2 : 0, pointerEvents: "box-none" }}
        >
          <Label
            size={12}
            line={list() ? 18 : 16}
            lines={list() ? 2 : 1}
            style={{ pointerEvents: "none" }}
          >
            {props.placement ? props.artifact.title : title()}
          </Label>
          <If when={props.placement}>
            <View style={{ ...row, gap: 6, pointerEvents: "box-none" }}>
              <Label
                size={10}
                line={14}
                tone="muted"
                lines={1}
                style={{ minWidth: 0, flexShrink: 1, pointerEvents: "none" }}
              >
                {metadata()}
              </Label>
              <If when={linkedTask()}>
                {(task) => (
                  <View
                    role="button"
                    accessibilityLabel={uiText("artifactOpenTask", {
                      number: task().number,
                    })}
                    accessibilityHint={task().title}
                    hitSlop={
                      props.phone
                        ? { top: 15, bottom: 15, left: 8, right: 8 }
                        : undefined
                    }
                    style={{
                      ...row,
                      flexShrink: 0,
                      paddingHorizontal: 3,
                      borderWidth: 1,
                      borderColor: c().border,
                      cursor: "pointer",
                      pointerEvents: "auto",
                    }}
                    hoverStyle={{ backgroundColor: c().canvas }}
                    focusVisibleStyle={{
                      outlineWidth: 1,
                      outlineColor: c().blue,
                    }}
                    onPress={() => props.onTask?.(task().id)}
                  >
                    <Label
                      size={10}
                      line={12}
                      tone="mutedInk"
                    >{`#${task().number}`}</Label>
                  </View>
                )}
              </If>
            </View>
          </If>
        </View>
      </View>
    </View>
  );
}

function previewDocument(url: URL) {
  const src = url.href
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${url.origin}; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>html,body,iframe{border:0;margin:0;width:100%;height:100%;display:block;background:#fff}</style>
<iframe title="Artifact" src="${src}" sandbox="allow-scripts allow-forms allow-modals allow-downloads" referrerpolicy="no-referrer" allow="camera 'none'; microphone 'none'"></iframe>
<script>addEventListener("message",e=>{
  if(e.source!==document.querySelector("iframe").contentWindow && e.data==="eta:print"){
    document.querySelector("iframe").contentWindow.postMessage({type:"eta:print"},"*");
  }
})</script>`;
}

function ArtifactPreview(props: {
  artifact: ArtifactView;
  initialVersion?: number;
  layout: Layout;
  onClose: () => void;
}) {
  const host = useHost();
  const c = colors();
  const phone = () => props.layout === "phone";
  const printsInFrame = platform.os === "web" || platform.os === "macos";
  const version = signal(
    props.initialVersion ?? props.artifact.versions[0]?.number,
  );
  const artifact = () =>
    host.artifacts().find((item) => item.id === props.artifact.id) ??
    props.artifact;
  const item = () =>
    artifact().versions.find((entry) => entry.number === version());
  const url = signal<URL | undefined>(undefined);
  const problem = signal("");
  const retry = signal(0);
  const busy = signal(false);
  const copied = signal(false);
  const confirmingShare = signal(false);
  const files = createArtifactFileSaver();
  const saveArtifactFile = files.save;
  const downloading = signal(false);
  const downloadProblem = signal("");
  let downloadRequest: AbortController | undefined;
  const viewer = computed(() => item()?.viewer);
  const pdfCapture = signal<CaptureArtifactPdf>();
  const exportingPdf = signal(false);
  const pdfProblem = signal("");
  const reloadingPdf = signal(false);
  let exportController: AbortController | undefined;
  let frame: WebViewRef | undefined;
  cleanup(() => exportController?.abort());
  function hostUrl(value: string, prefix: string): URL {
    const address = host.address();
    if (!address) throw new Error("Connect to an Eta host first.");
    const link = new URL(value, address.origin);
    if (
      link.origin !== new URL(address.origin).origin ||
      !link.pathname.startsWith(prefix) ||
      link.username ||
      link.password
    )
      throw new Error("The host returned an invalid artifact address.");
    return link;
  }
  effect(() => {
    retry();
    const number = version();
    const kind = viewer();
    const address = host.address();
    let active = true;
    cleanup(() => {
      active = false;
      downloadRequest?.abort();
    });
    url.set(undefined);
    problem.set("");
    copied.set(false);
    pdfCapture.set(undefined);
    downloadProblem.set("");
    files.savedPath.set("");
    pdfProblem.set("");
    exportController?.abort();
    if (number === undefined || !address || kind !== "iframe") return;
    void host
      .call<ArtifactResults["preview"]>("artifacts", "preview", {
        artifactId: props.artifact.id,
        version: number,
      })
      .then((result) => {
        if (active) url.set(hostUrl(result.url, "/preview/"));
      })
      .catch((error: unknown) => {
        if (active)
          problem.set(error instanceof Error ? error.message : String(error));
      });
  });
  function versionLabel(number: number) {
    return uiText("artifactVersionOption", {
      number,
      latest:
        number === artifact().versions[0]?.number
          ? uiText("latestArtifactVersion")
          : "",
    });
  }
  async function share() {
    const number = version();
    if (number === undefined || busy()) return;
    busy.set(true);
    const result = await host.action(() =>
      host.call<ArtifactResults["share"]>("artifacts", "share", {
        artifactId: props.artifact.id,
        version: number,
      }),
    );
    busy.set(false);
    if (result) confirmingShare.set(false);
  }
  async function unshare() {
    const number = version();
    if (number === undefined || busy()) return;
    busy.set(true);
    await host.action(() =>
      host.call("artifacts", "unshare", {
        artifactId: props.artifact.id,
        version: number,
      }),
    );
    copied.set(false);
    busy.set(false);
  }
  function openPreview() {
    const current = url();
    if (current) void host.action(() => openUrl(current.href));
  }

  function dismissPdf() {
    exportController?.abort();
    pdfProblem.set("");
    exportingPdf.set(false);
  }

  function retryPdf() {
    if (!reloadingPdf()) {
      void exportPdf();
      return;
    }
    dismissPdf();
    retry.update((attempt) => attempt + 1);
  }

  async function exportPdf() {
    if (downloading()) return;
    if (printsInFrame) {
      frame?.postMessage("eta:print");
      return;
    }
    const capture = pdfCapture();
    const number = version();
    if (!capture || number === undefined || exportController) return;
    const controller = new AbortController();
    exportController = controller;
    exportingPdf.set(true);
    pdfProblem.set("");
    reloadingPdf.set(false);
    try {
      const bytes = await capture(controller.signal);
      if (!controller.signal.aborted)
        await saveArtifactFile(
          bytes,
          props.artifact.title,
          number,
          "pdf",
          controller.signal,
        );
    } catch (error) {
      if (!controller.signal.aborted) {
        reloadingPdf.set(error instanceof ArtifactPdfResourcesError);
        pdfProblem.set(
          error instanceof Error && error.message
            ? error.message
            : uiText("artifactPdfRenderError"),
        );
      }
    } finally {
      exportingPdf.set(false);
      exportController = undefined;
    }
  }
  async function download() {
    const current = item();
    const address = host.address();
    if (!current || !address || downloading() || exportingPdf()) return;
    const request = new AbortController();
    downloadRequest = request;
    downloading.set(true);
    downloadProblem.set("");
    try {
      const link = hostUrl(current.archiveUrl, "/artifacts/");
      if (platform.os === "web") {
        await openUrl(link.href);
        return;
      }
      const response = await fetch(link.href, {
        signal: request.signal,
        redirect: "error",
        headers: address.token
          ? { Authorization: `Bearer ${address.token}` }
          : undefined,
      });
      if (!response.ok)
        throw new Error(
          uiText("artifactDownloadFailed", { status: String(response.status) }),
        );
      if (!response.headers.get("content-type")?.includes("application/zip"))
        throw new Error(uiText("artifactUnexpectedDownload"));
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!request.signal.aborted)
        await saveArtifactFile(
          bytes,
          props.artifact.title,
          current.number,
          "zip",
          request.signal,
        );
    } catch (error) {
      if (!request.signal.aborted)
        downloadProblem.set(
          error instanceof Error ? error.message : String(error),
        );
    } finally {
      if (downloadRequest === request) {
        downloadRequest = undefined;
        downloading.set(false);
      }
    }
  }
  function versionPicker() {
    return (
      <ActionMenu
        label={uiText("artifactVersion")}
        value={versionLabel(version() ?? 1)}
        triggerStyle={{
          height: phone() ? 28 : 24,
          minWidth: phone() ? 132 : 114,
        }}
      >
        <Each of={artifact().versions} key={(entry) => entry.number}>
          {(entry) => (
            <ActionItem
              label={versionLabel(entry().number)}
              checked={version() === entry().number}
              onSelect={() => version.set(entry().number)}
            />
          )}
        </Each>
      </ActionMenu>
    );
  }

  function shareButton() {
    return (
      <Button
        label={item()?.shareUrl ? uiText("unshare") : uiText("sharePublicly")}
        tone={phone() ? "plain" : "ghost"}
        size={phone() ? 28 : 24}
        labelSize={phone() ? 12 : 10}
        style={{ minWidth: phone() ? 99 : undefined }}
        disabled={busy() || !item()}
        onPress={() =>
          item()?.shareUrl ? void unshare() : confirmingShare.set(true)
        }
      />
    );
  }

  function exportButton() {
    return (
      <If when={item()?.viewer === "iframe"}>
        <Button
          label={uiText("exportPdf")}
          tone={phone() ? "plain" : "ghost"}
          size={phone() ? 28 : 24}
          labelSize={phone() ? 12 : 10}
          style={{ minWidth: phone() ? 82 : undefined }}
          disabled={
            !url() ||
            (!printsInFrame && !pdfCapture()) ||
            exportingPdf() ||
            downloading()
          }
          onPress={() => void exportPdf()}
        />
      </If>
    );
  }

  function phoneMenu() {
    return (
      <ActionMenu
        label={uiText("artifactActions")}
        triggerStyle={{ height: 26 }}
      >
        <If when={url()}>
          <ActionItem label={uiText("openInBrowser")} onSelect={openPreview} />
        </If>
        <If when={item()}>
          <ActionItem
            label={uiText(downloading() ? "downloading" : "download")}
            disabled={downloading() || exportingPdf()}
            onSelect={() => void download()}
          />
        </If>
      </ActionMenu>
    );
  }

  return (
    <Modal
      title={props.artifact.title}
      width={Math.max(0, windowSize().width - 64)}
      height={phone() ? "100%" : Math.max(0, windowSize().height - 64)}
      phone={phone()}
      phonePage={phone()}
      hideHeader={!phone()}
      blurBackdrop={props.layout === "desktop"}
      overPhoneNavigation
      headerActions={phone() ? phoneMenu() : undefined}
      onClose={props.onClose}
    >
      <If
        when={phone()}
        else={
          <View
            style={{
              ...row,
              paddingHorizontal: 12,
              gap: 4,
              flexShrink: 0,
              height: props.layout === "desktop" ? 40 : 36,
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <Icon name="artifact" size={12} tone="muted" />
            <Label
              size={12}
              weight={500}
              lines={1}
              style={{ flex: 1, minWidth: 0, marginLeft: 4 }}
            >
              {props.artifact.title}
            </Label>
            {versionPicker()}
            {shareButton()}
            {exportButton()}
            <If when={item()?.viewer === "iframe"}>
              <Button
                label={uiText("openInNewWindow")}
                tone="ghost"
                labelSize={10}
                disabled={!url()}
                onPress={openPreview}
              />
            </If>
            <Button
              label={uiText(downloading() ? "downloading" : "download")}
              tone="ghost"
              labelSize={10}
              disabled={!item() || downloading() || exportingPdf()}
              onPress={() => void download()}
            />
            <Button
              label={uiText("close")}
              icon="close"
              iconOnly
              tone="ghost"
              onPress={props.onClose}
            />
          </View>
        }
      >
        <View
          style={{
            ...row,
            justifyContent: "space-between",
            flexWrap: "wrap",
            flexShrink: 0,
            paddingHorizontal: 16,
            paddingVertical: 6,
            minHeight: 44,
            borderBottomWidth: 1,
            borderColor: c().border,
            gap: 4,
          }}
        >
          {versionPicker()}
          <View style={{ ...row, gap: 8 }}>
            {exportButton()}
            {shareButton()}
          </View>
        </View>
      </If>
      {files.writer()}
      <If when={downloadProblem()}>
        <View style={{ ...row, padding: 8, gap: 8 }}>
          <Label size={12} style={{ flex: 1 }} tone="red">
            {downloadProblem()}
          </Label>
          <Button label={uiText("retry")} onPress={() => void download()} />
        </View>
      </If>
      <If when={files.savedPath()}>
        <View style={{ ...row, padding: 8, gap: 8 }}>
          <Label size={12} style={{ flex: 1 }}>
            {uiText("artifactSavedTo", { path: files.savedPath() })}
          </Label>
          <Button
            label={uiText("artifactCopyPath")}
            onPress={() =>
              void host.action(() => Clipboard.writeText(files.savedPath()))
            }
          />
        </View>
      </If>
      <If when={item()?.shareUrl}>
        {(shareUrl) => (
          <View
            style={{
              ...row,
              padding: 8,
              gap: 10,
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <Label size={12} lines={1} style={{ flex: 1 }}>
              {shareUrl()}
            </Label>
            <Button
              label={copied() ? uiText("copied") : uiText("copyPublicLink")}
              onPress={() =>
                void host.action(async () => {
                  const address = host.address();
                  if (!address) return;
                  const link = new URL(shareUrl(), address.origin);
                  if (
                    !["http:", "https:"].includes(link.protocol) ||
                    link.username ||
                    link.password
                  )
                    throw new Error("The host returned an invalid share link.");
                  await Clipboard.writeText(link.href);
                  copied.set(true);
                })
              }
            />
          </View>
        )}
      </If>
      <If
        when={problem()}
        else={
          <If
            when={url()}
            else={
              <Empty
                title={
                  item()?.viewer === "download"
                    ? uiText("availableAsAZipDownload")
                    : uiText("openingPreview")
                }
              />
            }
          >
            {(link) =>
              !printsInFrame ? (
                <ArtifactPdfPreview
                  url={link()}
                  onCapture={pdfCapture.set}
                  onError={problem.set}
                />
              ) : (
                <WebView
                  html={previewDocument(link())}
                  incognito
                  style={grow}
                  ref={(node) => {
                    frame = node;
                  }}
                  onError={(error) => problem.set(error.message)}
                />
              )
            }
          </If>
        }
      >
        <Empty title={uiText("previewUnavailable")} description={problem()}>
          <Button
            label={uiText("retry")}
            onPress={() => retry.update((attempt) => attempt + 1)}
          />
          <If when={url()}>
            <Button label={uiText("openInBrowser")} onPress={openPreview} />
          </If>
        </Empty>
      </If>
      <If when={exportingPdf() || !!pdfProblem()}>
        <Modal
          title={uiText("exportPdf")}
          phone={phone()}
          sheet={phone()}
          onClose={dismissPdf}
        >
          <View style={{ padding: 16, gap: 12 }}>
            <Label size={13} line={19}>
              {pdfProblem() || uiText("artifactPdfPreparing")}
            </Label>
            <View style={{ ...row, justifyContent: "flex-end", gap: 8 }}>
              <Button label={uiText("cancel")} onPress={dismissPdf} />
              <If when={pdfProblem()}>
                <Button
                  label={uiText("retry")}
                  tone="primary"
                  onPress={retryPdf}
                />
              </If>
            </View>
          </View>
        </Modal>
      </If>
      <If when={confirmingShare()}>
        <Modal
          title={uiText("shareThisVersionPublicly")}
          phone={phone()}
          sheet={phone()}
          onClose={() => confirmingShare.set(false)}
        >
          <View style={{ padding: 16, gap: 10 }}>
            <Label>{uiText("anyoneWithTheLinkCanOpen")}</Label>
            <View style={{ ...row, justifyContent: "flex-end", gap: 8 }}>
              <Button
                label={uiText("cancel")}
                disabled={busy()}
                onPress={() => confirmingShare.set(false)}
              />
              <Button
                label={uiText("sharePublicly")}
                tone="primary"
                disabled={busy()}
                onPress={() => void share()}
              />
            </View>
          </View>
        </Modal>
      </If>
    </Modal>
  );
}

function Message(props: {
  item: MessageView;
  additions: MessageView[];
  canInsert: boolean;
  onInsert: () => void;
  phone: boolean;
  compact?: boolean;
  members: MemberView[];
  onArtifact: (artifact: ArtifactView, version: number) => void;
  onWidgetDraft: (text: string) => void;
  onTask: (id: string) => void;
}) {
  const host = useHost();
  const c = colors();
  const details = signal(false);
  const item = () => props.item;
  const review = () => {
    if (item().author !== "system") return undefined;
    const metadata = item().data.captainReview;
    if (
      metadata &&
      typeof metadata === "object" &&
      "reviews" in metadata &&
      Array.isArray(metadata.reviews)
    )
      return metadata.reviews.flatMap((entry: unknown) => {
        if (
          !entry ||
          typeof entry !== "object" ||
          !("body" in entry) ||
          typeof entry.body !== "string"
        )
          return [];
        return [entry.body];
      });
    const older = /<captain-review>([\s\S]*?)<\/captain-review>/.exec(
      item().text,
    )?.[1];
    return older
      ?.split(/^\d+\. \[[^\]]+\]\s*/m)
      .slice(1)
      .map((entry) => (entry.split("\n{")[0] ?? "").trim())
      .filter(Boolean);
  };
  const expandedReview = signal(false);
  let previousId: string | undefined;
  effect(() => {
    const id = item().id;
    if (id !== previousId) details.set(false);
    previousId = id;
  });
  const active = () => activeReply(item().status);
  const session = () =>
    activeReply(item().status)
      ? props.members.find((member) => member.agentId === item().agentId)
          ?.sessionId
      : undefined;
  const target = () => (session() ? `sessions.${session()}` : undefined);
  follow(target);
  const steps = () => {
    const id = target();
    if (!id) return savedSteps(item());
    return runBlocks(
      host.section<TranscriptSection>(id, "transcript")?.messages ?? [],
      host.section<ViewCore>(id, "core")?.streaming,
      runFromOf(item().data),
    );
  };
  const attached = () =>
    Array.isArray(item().data.attachments)
      ? (item().data.attachments as AttachmentView[])
      : [];
  const stamp = () => messageTime(item().createdAt, props.phone);
  const artifacts = () =>
    publishedRefs(steps()).flatMap((ref) => {
      const artifact = host
        .artifacts()
        .find((entry) => entry.id === ref.artifactId);
      return artifact ? [{ ref, artifact }] : [];
    });
  const widgets = () =>
    steps().flatMap((step) => {
      const widget = widgetFrom(step);
      return widget ? [widget] : [];
    });
  const question = () =>
    host.pending().find((entry) => entry.replyId === item().id);
  const operation = () => {
    const proposal = captainProposalOf(item());
    return proposal
      ? host
          .list<CaptainOperationView>("captain", "operations")
          .find((op) => op.id === proposal.operationId)
      : undefined;
  };
  const task = () =>
    [
      ...host.tasks(),
      ...host.list<import("@eta/client-contracts").BoardTaskView>(
        "tasks",
        "archived",
      ),
    ].find((entry) => entry.id === item().data.taskId);
  return (
    <View
      style={{
        alignSelf: "stretch",
        gap: 4,
        paddingVertical: props.phone ? 0 : 16,
        paddingHorizontal: props.phone || props.compact ? 0 : 16,
      }}
    >
      <If when={item().author === "user"}>
        <View style={{ alignItems: "flex-end", gap: 6 }}>
          <View
            style={{
              maxWidth: props.phone ? "84%" : "72%",
              borderWidth: 1,
              borderColor: c().border,
              backgroundColor: c().surface,
              paddingVertical: 8,
              paddingHorizontal: 12,
            }}
          >
            <Label line={props.phone ? 22 : 23}>{item().text}</Label>
            <Each of={props.additions} key={(addition) => addition.id}>
              {(addition) => (
                <View
                  style={{
                    gap: 3,
                    marginTop: 6,
                    paddingTop: 6,
                    borderTopWidth: 1,
                    borderColor: c().border,
                  }}
                >
                  <Label size={10} tone="muted">
                    {uiText("inserted", { clock: clock(addition().createdAt) })}
                  </Label>
                  <Label>{addition().text}</Label>
                </View>
              )}
            </Each>
            <Each of={attached()} key={(file) => file.id}>
              {(file) => (
                <Label line={props.phone ? 22 : 23}>
                  {`[${file().name} · ${(file().size / 1024).toFixed(1)} KB]`}
                </Label>
              )}
            </Each>
          </View>
          <Label
            size={10}
            line={14}
            tone="faint"
            style={{
              textTransform: props.phone ? "none" : "uppercase",
              letterSpacing: props.phone ? 0 : 0.4,
            }}
          >
            {stamp()}
          </Label>
          <If when={props.canInsert}>
            <Button
              label={uiText("insert")}
              tone="ghost"
              size={26}
              onPress={props.onInsert}
            />
          </If>
        </View>
      </If>
      <If when={item().kind === "task_card" || item().kind === "task_draft"}>
        <If when={task()}>
          {(value) => (
            <TaskSummary
              task={value()}
              onPress={() => props.onTask(value().id)}
            />
          )}
        </If>
        <If when={item().kind === "task_draft"}>
          <View
            style={{
              padding: 10,
              borderWidth: 1,
              borderColor: c().border,
              gap: 6,
            }}
          >
            <Caption text={uiText("taskDraft")} />
            <Label>{String(item().data.title ?? item().text)}</Label>
            <Button
              label={uiText("confirmTask")}
              onPress={() =>
                void host.action(() =>
                  host.call("tasks", "confirmDraft", {
                    conversationId: item().conversationId,
                    messageId: item().id,
                  }),
                )
              }
            />
          </View>
        </If>
      </If>
      <If when={operation()}>{(op) => <Proposal operation={op()} />}</If>
      <If
        when={
          item().author !== "user" &&
          item().kind !== "task_card" &&
          item().kind !== "task_draft" &&
          !operation()
        }
      >
        <If when={item().agentId}>
          <View style={{ ...row, gap: 8, marginBottom: 5 }}>
            <AgentFace id={item().agentId} size={14} />
            <Label size={12} weight={600}>
              {host.agent(item().agentId)?.name ??
                (item().author === "captain" ? "Captain" : uiText("agent"))}
            </Label>
          </View>
        </If>
        <If
          when={active()}
          else={
            <If when={steps().length}>
              <View
                role="button"
                accessibilityLabel={uiText("thinkingProcess")}
                accessibilityState={{ expanded: details() }}
                onPress={() => details.set(!details())}
                hoverStyle={{ backgroundColor: c().selected }}
                style={{
                  ...row,
                  height: 26,
                  gap: 8,
                  paddingHorizontal: 10,
                  borderWidth: 1,
                  borderColor: c().border,
                  cursor: "pointer",
                }}
              >
                <Icon
                  name={details() ? "down" : "right"}
                  size={8}
                  tone="faint"
                />
                <Caption text={uiText("thinkingProcess")} />
                <View style={{ flex: 1 }} />
                <Caption
                  text={uiText(
                    steps().length === 1
                      ? "oneProcessStep"
                      : "processStepCount",
                    {
                      count: steps().length,
                    },
                  )}
                />
              </View>
              <If when={details()}>
                <View
                  style={{
                    borderWidth: 1,
                    borderTopWidth: 0,
                    borderColor: c().border,
                  }}
                >
                  <Each of={steps()} key={(step) => step.id}>
                    {(step) => <ProcessStep value={step()} />}
                  </Each>
                </View>
              </If>
            </If>
          }
        >
          <View style={{ borderWidth: 1, borderColor: c().border }}>
            <View
              style={{
                ...row,
                height: 24,
                paddingHorizontal: 8,
                justifyContent: "space-between",
                borderBottomWidth: 1,
                borderColor: c().border,
              }}
            >
              <Label size={10} tone="muted">
                {steps().length
                  ? uiText("processSteps", { length: steps().length })
                  : item().status === "queued"
                    ? uiText("queued")
                    : item().status === "stopping"
                      ? uiText("stopping")
                      : uiText("working")}
              </Label>
              <Button
                label={uiText("stop")}
                size={18}
                labelSize={10}
                disabled={item().status === "stopping"}
                onPress={() =>
                  void host.action(() =>
                    host.call("conversations", "stop", {
                      conversationId: item().conversationId,
                      messageId: item().id,
                    }),
                  )
                }
              />
            </View>
            <Each
              of={details() ? steps() : steps().slice(-5)}
              key={(step) => step.id}
            >
              {(step) => <ProcessStep value={step()} />}
            </Each>
          </View>
          <If when={steps().length > 5}>
            <View style={{ alignItems: "flex-end" }}>
              <Button
                label={details() ? uiText("viewLess") : uiText("viewMore")}
                labelSize={10}
                tone="ghost"
                onPress={() => details.set(!details())}
              />
            </View>
          </If>
        </If>
        <If
          when={review()}
          else={
            <If when={item().text}>
              <If
                when={item().status === "failed"}
                else={
                  <Markdown value={item().text} line={props.phone ? 22 : 24} />
                }
              >
                <Label line={props.phone ? 22 : 24} tone="amber">
                  {item().text}
                </Label>
              </If>
            </If>
          }
        >
          {(items) => (
            <View
              style={{
                borderWidth: 1,
                borderColor: c().border,
                padding: 8,
                gap: 5,
              }}
            >
              <Button
                label={uiText("captainReview", { length: items().length })}
                end={expandedReview() ? "down" : "right"}
                tone="ghost"
                onPress={() => expandedReview.set(!expandedReview())}
              />
              <If when={expandedReview()}>
                <Each of={items()} key="index">
                  {(body) => <Markdown value={body()} line={20} />}
                </Each>
              </If>
            </View>
          )}
        </If>
        <Each of={widgets()} key={(widget) => widget.id}>
          {(widget) => (
            <Widget value={widget()} onDraft={props.onWidgetDraft} />
          )}
        </Each>
        <Each of={artifacts()} key={(entry) => entry.ref.id}>
          {(entry) => (
            <ArtifactRow
              artifact={entry().artifact}
              version={entry().ref.version}
              onPress={() =>
                props.onArtifact(entry().artifact, entry().ref.version)
              }
            />
          )}
        </Each>
        <If when={question()}>{(entry) => <Question item={entry()} />}</If>
        <Label
          size={10}
          line={14}
          tone="faint"
          style={{
            marginTop: 4,
            letterSpacing: props.phone ? 0 : 0.4,
            textTransform: props.phone ? "none" : "uppercase",
          }}
        >
          {stamp()}
        </Label>
      </If>
    </View>
  );
}

function ProcessStep(props: { value: RunBlock }) {
  const host = useHost();
  const c = colors();
  const tool = () => (props.value.type === "tool" ? props.value : undefined);
  const expanded = signal(false);
  const emailProposalId = () => {
    const step = tool();
    const details = step?.details;
    return step &&
      ["send_email", "reply"].includes(step.name) &&
      details &&
      typeof details === "object" &&
      "emailProposalId" in details &&
      typeof details.emailProposalId === "string"
      ? details.emailProposalId
      : undefined;
  };
  follow(() => (emailProposalId() ? "email" : undefined));
  const emailProposal = () => {
    const id = emailProposalId();
    if (!id) return undefined;
    return host
      .list<EmailProposalView>("email", "proposals")
      .find(
        (item) =>
          item.id === id &&
          (item.status === "pending" || item.status === "failed"),
      );
  };
  const title = () => {
    const step = tool();
    if (!step) return "";
    const input = step.input;
    const path =
      input &&
      typeof input === "object" &&
      "path" in input &&
      typeof input.path === "string"
        ? input.path
        : undefined;
    const detail = commandOf(input) ?? path;
    return step.name + (detail ? ` · ${detail}` : "");
  };
  return (
    <If
      when={emailProposal()}
      else={
        <If
          when={tool()}
          else={
            <View
              style={{
                padding: 8,
                borderBottomWidth: 1,
                borderColor: c().border,
              }}
            >
              <If
                when={props.value.type === "text"}
                else={
                  <Label size={12} tone="muted">
                    {props.value.type === "thinking"
                      ? props.value.text
                      : uiText("messageJoinedThisRun")}
                  </Label>
                }
              >
                <Markdown
                  value={props.value.type === "text" ? props.value.text : ""}
                  line={22}
                  streaming
                />
              </If>
            </View>
          }
        >
          {(step) => (
            <View>
              <View
                role={step().output ? "button" : undefined}
                onPress={
                  step().output ? () => expanded.set(!expanded()) : undefined
                }
                style={{
                  ...row,
                  minHeight: 33,
                  paddingHorizontal: 9,
                  gap: 8,
                  borderBottomWidth: 1,
                  borderColor: c().border,
                }}
              >
                <Label size={12} lines={1} style={{ flex: 1 }}>
                  {title()}
                </Label>
                <Caption
                  text={
                    step().status === "running"
                      ? uiText("inProgress")
                      : step().status === "completed"
                        ? uiText("done")
                        : uiText("failed")
                  }
                  style={
                    step().status === "running"
                      ? {
                          backgroundColor: c().button,
                          color: c().buttonInk,
                          paddingHorizontal: 6,
                        }
                      : undefined
                  }
                />
              </View>
              <If when={expanded() && step().output}>
                <View style={{ padding: 8, backgroundColor: c().surface }}>
                  <Label size={12} tone="muted">
                    {step().output}
                  </Label>
                </View>
              </If>
            </View>
          )}
        </If>
      }
    >
      {(proposal) => <EmailProposal item={proposal()} />}
    </If>
  );
}

function Composer(props: {
  id: string;
  name: string;
  members: MemberView[];
  steward?: string | null;
  group: boolean;
  phone: boolean;
  alignWithContent?: boolean;
  held: MessageView[];
  widgetDraft?: { conversationId: string; text: string } | undefined;
}) {
  const host = useHost();
  const c = colors();
  const draft = signal("");
  const mentions = signal<string[] | null>(null);
  const attachments = signal<AttachmentView[]>([]);
  const busy = signal(false);
  let appliedWidgetDraft: typeof props.widgetDraft;
  effect(() => {
    const suggestion = props.widgetDraft;
    if (
      busy() ||
      !suggestion ||
      suggestion === appliedWidgetDraft ||
      suggestion.conversationId !== props.id
    )
      return;
    appliedWidgetDraft = suggestion;
    draft.update((text) =>
      text ? `${text}\n${suggestion.text}` : suggestion.text,
    );
  });
  const uploading = signal(false);
  const mode = signal<"queue" | "steer">("queue");
  let attempt: { id: string; content: string } | undefined;
  const running = () =>
    props.members.some((member) => activeReply(member.status));
  const recipients = () =>
    mentions() ??
    (props.steward
      ? [props.steward]
      : props.members.length === 1
        ? [props.members[0]!.agentId]
        : []);
  const names = () =>
    recipients()
      .map((id) => host.agent(id)?.name)
      .filter(Boolean)
      .join(", ");
  const mentionQuery = () =>
    props.group ? /(?:^|\s)@([^\s@]*)$/.exec(draft())?.[1] : undefined;
  const choices = () => {
    const query = mentionQuery()?.toLowerCase();
    return query === undefined
      ? []
      : props.members
          .flatMap((member) => {
            const agent = host.agent(member.agentId);
            return agent && agent.name.toLowerCase().includes(query)
              ? [agent]
              : [];
          })
          .slice(0, 5);
  };
  function chooseMention(id: string, name: string) {
    draft.update((value) => value.replace(/@[^\s@]*$/, `@${name} `));
    mentions.update((current) => [...new Set([...(current ?? []), id])]);
  }
  function submit() {
    const first = choices()[0];
    if (first) chooseMention(first.id, first.name);
    else void send();
  }
  const sendable = () =>
    (draft().trim() || attachments().length) &&
    !busy() &&
    !uploading() &&
    host.state().status === "open";
  async function send() {
    if (!sendable()) return;
    busy.set(true);
    const outgoing = {
      conversationId: props.id,
      text: draft().trim(),
      mentions: mentions() ?? undefined,
      mode: mode(),
      attachments: attachments().map((file) => file.id),
    };
    const content = JSON.stringify(outgoing);
    if (attempt?.content !== content)
      attempt = { id: crypto.randomUUID(), content };
    const clientId = attempt.id;
    const result = await host.action(() =>
      host.call<ConversationResults["send"]>("conversations", "send", {
        ...outgoing,
        clientId,
      }),
    );
    busy.set(false);
    if (result) {
      draft.set("");
      attachments.set([]);
      mentions.set(null);
      mode.set("queue");
      attempt = undefined;
    }
  }
  async function attach() {
    if (uploading() || busy()) return;
    uploading.set(true);
    await host.action(async () => {
      const chosen = await Picker.pickFiles({
        multiple: true,
        maxSize: MAX_ATTACHMENT_BYTES,
      });
      if (chosen.length + attachments().length > MAX_ATTACHMENTS)
        throw new Error(
          `A message can carry up to ${MAX_ATTACHMENTS} attachments.`,
        );
      for (const file of chosen) {
        if (!file.file)
          throw new Error(`${file.name} exceeds the attachment size limit.`);
        const bytes = new Uint8Array(await file.file.arrayBuffer());
        const id = crypto.randomUUID();
        try {
          for (
            let offset = 0, index = 0;
            offset < bytes.length || index === 0;
            offset += ATTACH_CHUNK_BYTES, index++
          ) {
            const result = await host.call<ConversationResults["attach"]>(
              "conversations",
              "attach",
              {
                conversationId: props.id,
                uploadId: id,
                name: file.name,
                contentType: file.type ?? undefined,
                index,
                last: offset + ATTACH_CHUNK_BYTES >= bytes.length,
                data: Buffer.from(
                  bytes.subarray(offset, offset + ATTACH_CHUNK_BYTES),
                ).toString("base64"),
              },
            );
            if (result.attachment)
              attachments.update((list) => [...list, result.attachment!]);
          }
        } catch (error) {
          await host
            .call("conversations", "unattach", {
              conversationId: props.id,
              attachmentId: id,
            })
            .catch(() => {});
          throw error;
        }
      }
    });
    uploading.set(false);
  }
  function toggle(id: string) {
    const selected = recipients();
    const next = selected.includes(id)
      ? selected.filter((entry) => entry !== id)
      : [...selected, id];
    mentions.set(next.length ? next : null);
  }
  return (
    <View
      style={{
        position: "relative",
        zIndex: 2,
        paddingVertical: props.phone ? 12 : 16,
        paddingHorizontal: props.phone ? 12 : props.alignWithContent ? 0 : 16,
        paddingTop: 8,
        gap: 8,
        flexShrink: 0,
        borderTopWidth: props.phone ? 1 : 0,
        borderColor: c().border,
        backgroundColor: c().canvas,
      }}
    >
      <If when={choices().length && !busy()}>
        <View
          role="group"
          accessibilityLabel={uiText("mentionAnAgent")}
          style={{
            position: "absolute",
            bottom: "100%",
            left: props.phone ? 12 : 16,
            zIndex: 3,
            minWidth: 180,
            borderWidth: 1,
            borderColor: c().strong,
            backgroundColor: c().canvas,
            padding: 4,
            gap: 2,
          }}
        >
          <Caption
            text={uiText("mentionAnAgent")}
            style={{ paddingHorizontal: 8, paddingVertical: 3 }}
          />
          <Each of={choices()} key={(entry) => entry.id}>
            {(entry) => (
              <View
                role="button"
                accessibilityLabel={uiText("mention", { name: entry().name })}
                onPress={() => chooseMention(entry().id, entry().name)}
                hoverStyle={{ backgroundColor: c().selected }}
                style={{
                  ...row,
                  minHeight: 28,
                  paddingHorizontal: 8,
                  gap: 8,
                  cursor: "pointer",
                }}
              >
                <AgentFace id={entry().id} size={16} />
                <Label size={12}>{entry().name}</Label>
              </View>
            )}
          </Each>
        </View>
      </If>
      <Each of={props.held} key={(message) => message.id}>
        {(message) => (
          <View style={{ ...row, gap: 6 }}>
            <Label size={12} tone="muted" style={{ flex: 1 }} lines={1}>
              {uiText("queuedWithCount", { text: message().text })}
            </Label>
            <Button
              label={uiText("steer")}
              onPress={() =>
                void host.action(() =>
                  host.call("conversations", "steerHeld", {
                    conversationId: props.id,
                    messageId: message().id,
                  }),
                )
              }
            />
            <Button
              label={uiText("recall")}
              onPress={() =>
                void host.action(async () => {
                  const result = await host.call<ConversationResults["recall"]>(
                    "conversations",
                    "recall",
                    { conversationId: props.id, messageId: message().id },
                  );
                  if (result.recalled)
                    draft.update((text) =>
                      [text, message().text].filter(Boolean).join("\n"),
                    );
                })
              }
            />
          </View>
        )}
      </Each>
      <If when={props.group}>
        <View
          style={{
            flexDirection: props.phone ? "column-reverse" : "row",
            alignItems: props.phone ? "flex-start" : "center",
            justifyContent: "space-between",
            gap: 5,
          }}
        >
          <View style={{ ...row, gap: 6, flexWrap: "wrap" }}>
            <View
              role="button"
              accessibilityLabel={uiText("everyone")}
              accessibilityState={{
                selected: mentions()?.length === props.members.length,
              }}
              onPress={() =>
                mentions.set(
                  mentions()?.length === props.members.length
                    ? null
                    : props.members.map((member) => member.agentId),
                )
              }
              hoverStyle={{ backgroundColor: c().selected }}
              style={{
                ...row,
                height: 28,
                gap: 6,
                paddingLeft: 8,
                paddingRight: 10,
                borderWidth: 1,
                borderColor: c().border,
                backgroundColor: c().surface,
                cursor: "pointer",
              }}
            >
              <View
                style={{
                  ...row,
                  justifyContent: "center",
                  width: 14,
                  height: 14,
                  borderWidth: 1,
                  borderColor: c().strong,
                }}
              >
                <If when={mentions()?.length === props.members.length}>
                  <Icon name="check" size={10} />
                </If>
              </View>
              <Label size={12} line={16} tone="mutedInk">
                {uiText("everyone")}
              </Label>
            </View>
            <Each of={props.members} key={(member) => member.agentId}>
              {(member) => (
                <View
                  role="button"
                  accessibilityLabel={
                    host.agent(member().agentId)?.name ?? uiText("agent")
                  }
                  accessibilityState={{
                    selected: recipients().includes(member().agentId),
                  }}
                  onPress={() => toggle(member().agentId)}
                  hoverStyle={{ backgroundColor: c().selected }}
                  style={{
                    ...row,
                    height: 28,
                    gap: 6,
                    paddingLeft: 6,
                    paddingRight: 10,
                    borderWidth: 1,
                    borderColor: recipients().includes(member().agentId)
                      ? c().ink
                      : c().border,
                    cursor: "pointer",
                    backgroundColor: recipients().includes(member().agentId)
                      ? c().canvas
                      : c().surface,
                  }}
                >
                  <AgentFace id={member().agentId} size={16} />
                  <Label
                    size={12}
                    line={16}
                    lines={1}
                    tone={
                      recipients().includes(member().agentId)
                        ? "ink"
                        : "mutedInk"
                    }
                    weight={recipients().includes(member().agentId) ? 600 : 400}
                  >
                    {host.agent(member().agentId)?.name ?? uiText("agent")}
                  </Label>
                  <If when={!props.phone && member().agentId === props.steward}>
                    <Label size={10} tone="muted">
                      {uiText("steward")}
                    </Label>
                  </If>
                </View>
              )}
            </Each>
          </View>
          <View style={{ ...row, gap: 6 }}>
            <View
              style={{
                width: 6,
                height: 6,
                backgroundColor: running() ? c().blue : c().green,
              }}
            />
            <Label size={12} line={16} tone="muted">
              {names()
                ? running()
                  ? `${names()} · ${uiText(mode() === "steer" ? "steer" : "queue")}`
                  : uiText(
                      recipients().length > 1
                        ? "recipientsReply"
                        : "recipientReplies",
                      {
                        names: names(),
                      },
                    )
                : uiText("chooseWhoShouldReply")}
            </Label>
          </View>
        </View>
      </If>
      <If when={attachments().length}>
        <View style={{ ...row, flexWrap: "wrap", gap: 5 }}>
          <Each of={attachments()} key={(file) => file.id}>
            {(file) => (
              <Button
                label={file().name}
                end="close"
                disabled={busy()}
                onPress={() =>
                  void host.action(async () => {
                    await host.call("conversations", "unattach", {
                      conversationId: props.id,
                      attachmentId: file().id,
                    });
                    attachments.update((list) =>
                      list.filter((entry) => entry.id !== file().id),
                    );
                  })
                }
              />
            )}
          </Each>
        </View>
      </If>
      <View
        style={{
          borderWidth: 1,
          borderColor: c().ink,
          flexDirection: props.phone ? "row" : "column",
          alignItems: props.phone ? "center" : "stretch",
        }}
      >
        <Field
          label={uiText("message")}
          placeholder={uiText("messageWithCount", { name: props.name })}
          multiline={!props.phone}
          value={draft()}
          onChange={(value) => {
            if (!busy()) draft.set(value);
          }}
          onSubmit={submit}
          style={{
            height: props.phone ? 42 : 48,
            flex: props.phone ? 1 : undefined,
            borderWidth: 0,
            paddingVertical: props.phone ? 7 : 12,
            paddingHorizontal: 12,
          }}
        />
        <View
          style={{
            ...row,
            height: 40,
            paddingLeft: props.phone ? 0 : 7,
            paddingRight: 6,
            gap: 6,
            backgroundColor: props.phone ? c().canvas : c().surface,
            borderTopWidth: props.phone ? 0 : 1,
            borderColor: c().border,
          }}
        >
          <Button
            label={uiText("attachFiles")}
            icon="clip"
            iconOnly
            tone="ghost"
            disabled={uploading() || busy()}
            onPress={() => void attach()}
          />
          <View style={{ flex: props.phone ? 0 : 1 }} />
          <If when={running() && !props.phone}>
            <Button
              label={mode() === "queue" ? uiText("queue") : uiText("steer")}
              onPress={() => mode.set(mode() === "queue" ? "steer" : "queue")}
            />
            <Button
              label={uiText("stop")}
              onPress={() =>
                void host.action(() =>
                  host.call("conversations", "stop", {
                    conversationId: props.id,
                  }),
                )
              }
            />
          </If>
          <Button
            label={uiText("send")}
            icon={props.phone ? "arrowUp" : undefined}
            iconOnly={props.phone}
            end={props.phone ? undefined : "return"}
            size={props.phone ? 32 : 28}
            labelSize={11}
            tone="primary"
            dimDisabled={busy() || uploading()}
            disabled={!sendable()}
            onPress={() => void send()}
          />
        </View>
      </View>
    </View>
  );
}

export function Pending(props: {
  conversationId?: string;
  layout: Layout;
  onTask?: (id: string) => void;
  onRoutines?: (id?: string) => void;
  onConversation?: (id: string) => void;
}) {
  const host = useHost();
  const c = colors();
  const chosenId = signal("");
  const chosen = () => host.pending().find((entry) => entry.id === chosenId());
  const proposalId = signal("");
  const phone = () => props.layout === "phone";
  follow(() => "routines");
  const items = () =>
    host
      .pending()
      .filter(
        (entry) =>
          !props.conversationId ||
          entry.conversationId === props.conversationId,
      );
  const operations = () =>
    host.list<CaptainOperationView>("captain", "operations");
  const proposals = () =>
    operations().filter(
      (op) =>
        op.requiresApproval &&
        op.status === "pending" &&
        (!props.conversationId ||
          op.payload.originConversationId === props.conversationId),
    );
  const proposal = () => operations().find((op) => op.id === proposalId());
  const reviews = () =>
    host
      .tasks()
      .filter(
        (item) =>
          taskNeedsAttention(item) &&
          (!props.conversationId ||
            item.conversationId === props.conversationId),
      );
  const routines = () => host.list<RoutineSummary>("routines");
  const reports = () =>
    routines().filter((item) => item.unseenReports || item.unseenFailures);
  function PendingRow(props: {
    title: string;
    detail: string;
    agent?: string | null;
    icon?: "tasks" | "routines";
    when?: number;
    attention?: boolean;
    onPress: () => void;
  }) {
    return (
      <View
        role="button"
        accessibilityLabel={props.title}
        onPress={props.onPress}
        hoverStyle={{ backgroundColor: c().selected }}
        style={{
          ...row,
          minHeight: 55,
          paddingHorizontal: 16,
          gap: 10,
          borderBottomWidth: 1,
          borderColor: c().border,
          cursor: "pointer",
        }}
      >
        <View style={{ width: 30, alignItems: "center", flexShrink: 0 }}>
          <If
            when={props.agent}
            else={
              <Icon
                name={props.icon ?? "bell"}
                size={17}
                tone={props.icon === "tasks" ? "amber" : "ink"}
              />
            }
          >
            <AgentFace id={props.agent} size={24} />
          </If>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label lines={1}>{props.title}</Label>
          <Label size={11} line={16} tone="muted" lines={1}>
            {props.detail}
          </Label>
        </View>
        <If when={props.attention}>
          <View
            style={{
              width: 6,
              height: 6,
              backgroundColor: props.icon === "routines" ? c().red : c().blue,
            }}
          />
        </If>
        <If when={props.when}>
          <Label size={10} tone="muted">
            {relativeTime(props.when!)}
          </Label>
        </If>
        <Icon name="right" size={9} tone="muted" />
      </View>
    );
  }
  return (
    <View style={{ ...grow, backgroundColor: c().canvas }}>
      <If when={!props.conversationId}>
        <Header title={uiText("pending")} layout={props.layout}>
          <Label size={11} tone="muted">
            {uiText("waitingForYou", {
              value1: items().length + proposals().length + reviews().length,
            })}
          </Label>
        </Header>
      </If>
      <If
        when={phone() && !props.conversationId}
        else={
          <If
            when={
              items().length +
                proposals().length +
                reviews().length +
                (props.onRoutines ? reports().length : 0) >
              0
            }
            else={<Empty title={uiText("nothingIsWaitingForYou")} />}
          >
            <Scroll style={grow}>
              <View style={{ gap: 8, padding: 12 }}>
                <Each of={items()} key={(entry) => entry.id}>
                  {(entry) => <Question item={entry()} />}
                </Each>
                <Each of={proposals()} key={(op) => op.id}>
                  {(op) => <Proposal operation={op()} />}
                </Each>
                <If when={reviews().length}>
                  <Caption
                    text={uiText("tasksToCheck", { length: reviews().length })}
                  />
                  <Each of={reviews()} key={(item) => item.id}>
                    {(item) => (
                      <PendingRow
                        title={`#${item().number} ${item().title}`}
                        detail={
                          item().status === "blocked"
                            ? uiText("prerequisiteCancelledDecide")
                            : uiText("inReviewReview")
                        }
                        icon="tasks"
                        onPress={() => props.onTask?.(item().id)}
                      />
                    )}
                  </Each>
                </If>
                <If when={props.onRoutines && reports().length}>
                  <Caption
                    text={uiText("routines", { length: reports().length })}
                  />
                  <Each of={reports()} key={(routine) => routine.id}>
                    {(routine) => (
                      <PendingRow
                        title={routine().name}
                        detail={
                          routine().unseenFailures
                            ? uiText("failedWithCount", {
                                unseenFailures: routine().unseenFailures,
                              })
                            : uiText("newReport", {
                                unseenReports: routine().unseenReports,
                              })
                        }
                        icon="routines"
                        attention={routine().unseenFailures > 0}
                        onPress={() => props.onRoutines?.(routine().id)}
                      />
                    )}
                  </Each>
                </If>
              </View>
            </Scroll>
          </If>
        }
      >
        <Scroll style={grow} scrollbar={false}>
          <PendingRow
            title={uiText("routines2")}
            icon="routines"
            detail={uiText("routinesNewReportsFailures", {
              length: routines().length,
              reduce: routines().reduce(
                (sum, item) => sum + item.unseenReports,
                0,
              ),
              value3: routines().reduce(
                (sum, item) => sum + item.unseenFailures,
                0,
              ),
            })}
            attention={routines().some((item) => item.unseenFailures > 0)}
            onPress={() => props.onRoutines?.()}
          />
          <View
            style={{
              height: 31,
              paddingHorizontal: 16,
              justifyContent: "center",
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <Caption
              text={uiText("confirmationRequest", {
                value1: items().length + proposals().length,
              })}
            />
          </View>
          <Each of={items()} key={(entry) => entry.id}>
            {(entry) => (
              <PendingRow
                title={entry().prompt}
                detail={uiText("questionFrom", {
                  value1: host.agent(entry().agentId)?.name ?? "Agent",
                  value2: entry().conversationId
                    ? ` · ${
                        host
                          .conversations()
                          .find((item) => item.id === entry().conversationId)
                          ?.name ?? "Conversation"
                      }`
                    : "",
                })}
                agent={entry().agentId}
                attention
                when={entry().createdAt}
                onPress={() => chosenId.set(entry().id)}
              />
            )}
          </Each>
          <Each of={proposals()} key={(item) => item.id}>
            {(item) => (
              <PendingRow
                title={String(
                  item().payload.title ??
                    item().payload.name ??
                    item().kind.replaceAll("_", " "),
                )}
                detail={uiText("proposalFromCaptain")}
                agent={host.captain()?.id}
                attention
                when={item().createdAt}
                onPress={() => proposalId.set(item().id)}
              />
            )}
          </Each>
          <View
            style={{
              height: 38,
              paddingHorizontal: 16,
              justifyContent: "center",
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <Caption text={uiText("tasks", { length: reviews().length })} />
          </View>
          <Each of={reviews()} key={(item) => item.id}>
            {(item) => (
              <PendingRow
                title={`#${item().number} ${item().title}`}
                detail={`${item().status === "blocked" ? "Needs your decision" : "For you to check"}${
                  item().conversationId
                    ? ` · ${
                        host
                          .conversations()
                          .find((entry) => entry.id === item().conversationId)
                          ?.name ?? "Conversation"
                      }`
                    : ""
                }`}
                icon="tasks"
                attention
                when={item().updatedAt}
                onPress={() => props.onTask?.(item().id)}
              />
            )}
          </Each>
        </Scroll>
      </If>
      <If when={chosen()}>
        {(entry) => (
          <Modal
            title={uiText("questionFromWithCount", {
              value1: host.agent(entry().agentId)?.name ?? "Agent",
            })}
            height={474}
            phone
            sheet
            hideHeader
            overPhoneNavigation
            onClose={() => chosenId.set("")}
          >
            <View
              style={{
                ...row,
                height: 44,
                paddingLeft: 16,
                paddingRight: 8,
                gap: 8,
                flexShrink: 0,
              }}
            >
              <AgentFace id={entry().agentId} size={20} />
              <Label size={14} line={20} weight={600} style={{ flex: 1 }}>
                {uiText("questionFromWithCount", {
                  value1: host.agent(entry().agentId)?.name ?? "Agent",
                })}
              </Label>
              <Button
                label={uiText("close")}
                tone="ghost"
                icon="close"
                iconOnly
                size={32}
                onPress={() => chosenId.set("")}
              />
            </View>
            <Question
              item={entry()}
              sheet
              onDone={() => chosenId.set("")}
              onConversation={
                entry().conversationId && props.onConversation
                  ? () => props.onConversation!(entry().conversationId!)
                  : undefined
              }
            />
          </Modal>
        )}
      </If>
      <If when={proposal()}>
        {(entry) => (
          <Modal
            title={uiText("proposalFromCaptain")}
            height={430}
            phone
            sheet
            overPhoneNavigation
            onClose={() => proposalId.set("")}
          >
            <Proposal
              operation={entry()}
              sheet
              onConversation={
                typeof entry().payload.originConversationId === "string" &&
                props.onConversation
                  ? () =>
                      props.onConversation!(
                        entry().payload.originConversationId as string,
                      )
                  : undefined
              }
            />
          </Modal>
        )}
      </If>
    </View>
  );
}

function StewardMenu(props: {
  conversationId: string;
  members: MemberView[];
  current?: string | null;
}) {
  const host = useHost();
  const c = colors();
  async function choose(agentId: string | null) {
    if (agentId === (props.current ?? null)) return;
    await host.action(() =>
      host.call("conversations", "setSteward", {
        conversationId: props.conversationId,
        agentId,
      }),
    );
  }
  const itemStyle = { ...row, gap: 8, paddingHorizontal: 10, height: 30 };
  return (
    <Menu
      placement="bottom"
      align="start"
      offset={3}
      popupStyle={{
        width: 172,
        borderWidth: 1,
        borderColor: c().strong,
        backgroundColor: c().canvas,
      }}
      trigger={
        <View
          accessibilityLabel={uiText("steward2")}
          hoverStyle={{ backgroundColor: c().selected }}
          style={{
            ...row,
            height: 22,
            gap: 6,
            paddingHorizontal: 5,
            borderWidth: 1,
            borderColor: c().border,
            cursor: "pointer",
          }}
        >
          <If when={props.current}>
            <AgentFace id={props.current} size={10} />
          </If>
          <Label size={11} line={16} tone="muted">
            {host.agent(props.current)?.name ?? uiText("steward2")}
          </Label>
          <Icon name="down" size={8} tone="muted" />
        </View>
      }
    >
      <Each of={props.members} key={(member) => member.agentId}>
        {(member) => (
          <MenuItem
            role="menuitemradio"
            checked={member().agentId === props.current}
            accessibilityLabel={
              host.agent(member().agentId)?.name ?? uiText("agent")
            }
            style={itemStyle}
            hoverStyle={{ backgroundColor: c().selected }}
            indicatorStyle={{ width: 0 }}
            onSelect={() => void choose(member().agentId)}
          >
            <AgentFace id={member().agentId} size={10} />
            <Label size={11} style={{ flex: 1 }}>
              {host.agent(member().agentId)?.name ?? uiText("agent")}
            </Label>
            <If when={member().agentId === props.current}>
              <Icon name="check" size={10} />
            </If>
          </MenuItem>
        )}
      </Each>
      <MenuSeparator style={{ height: 1, backgroundColor: c().border }} />
      <MenuItem
        role="menuitemradio"
        checked={!props.current}
        indicatorStyle={{ width: 0 }}
        style={itemStyle}
        hoverStyle={{ backgroundColor: c().selected }}
        onSelect={() => void choose(null)}
      >
        <Label size={11} style={{ flex: 1 }}>
          {uiText("noSteward")}
        </Label>
        <If when={!props.current}>
          <Icon name="check" size={10} />
        </If>
      </MenuItem>
    </Menu>
  );
}

function InviteAgents(props: {
  conversationId: string;
  members: MemberView[];
  layout: Layout;
  onClose: () => void;
}) {
  const host = useHost();
  const c = colors();
  const phone = () => props.layout === "phone";
  const title = () => uiText("inviteAgents");
  const selected = signal<string[]>([]);
  const saving = signal(false);
  const candidates = () =>
    host
      .people()
      .filter(
        (agent) => !props.members.some((member) => member.agentId === agent.id),
      );
  const inviteIds = () =>
    selected().filter((id) => candidates().some((agent) => agent.id === id));
  async function invite() {
    const agentIds = inviteIds();
    if (saving() || !agentIds.length) return;
    saving.set(true);
    const result = await host.action(() =>
      host.call("conversations", "invite", {
        conversationId: props.conversationId,
        agentIds,
      }),
    );
    saving.set(false);
    if (result) props.onClose();
  }
  const placement = () => ({
    left: Math.max(
      16,
      Math.min(windowSize().width / 2 + 16, windowSize().width - 400),
    ),
    top: Math.max(
      16,
      Math.min(windowSize().height / 2 - 32, windowSize().height - 264),
    ),
  });
  const content = () => (
    <>
      <If when={!phone()}>
        <View
          style={{
            ...row,
            justifyContent: "space-between",
            minHeight: 38,
            paddingHorizontal: 14,
          }}
        >
          <Label size={14} weight={500}>
            {title()}
          </Label>
          <Button
            label={uiText("close")}
            icon="close"
            iconOnly
            tone="ghost"
            size={18}
            disabled={saving()}
            onPress={props.onClose}
          />
        </View>
      </If>
      <View
        style={{
          paddingHorizontal: phone() ? 16 : 14,
          paddingTop: phone() ? 16 : 2,
          gap: phone() ? 10 : 12,
          ...(phone() ? grow : {}),
        }}
      >
        <Label tone="muted" size={phone() ? 12 : 10} line={16}>
          {uiText("membersCanReadTheGroupChat")}
        </Label>
        <Scroll
          style={
            phone()
              ? grow
              : {
                  maxHeight: Math.max(
                    64,
                    Math.min(225, windowSize().height - placement().top - 148),
                  ),
                }
          }
          scrollbar={false}
        >
          <Each of={candidates()} key={(agent) => agent.id}>
            {(agent) => (
              <Checkbox
                checked={selected().includes(agent().id)}
                accessibilityLabel={agent().name}
                onChange={({ checked }) =>
                  selected.update((ids) =>
                    checked
                      ? [...ids, agent().id]
                      : ids.filter((id) => id !== agent().id),
                  )
                }
                style={{
                  ...row,
                  gap: 8,
                  paddingHorizontal: phone() ? 4 : 0,
                  minHeight: phone() ? 52 : 32,
                  borderBottomWidth: phone() ? 1 : 0,
                  borderColor: c().border,
                  cursor: "pointer",
                }}
              >
                <View
                  style={{
                    width: 14,
                    height: 14,
                    borderWidth: 1,
                    borderColor: c().strong,
                    backgroundColor: selected().includes(agent().id)
                      ? c().button
                      : c().canvas,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <If when={selected().includes(agent().id)}>
                    <Icon name="check" size={10} tone="buttonInk" />
                  </If>
                </View>
                <AgentFace id={agent().id} size={phone() ? 24 : 12} />
                <Label style={{ flex: phone() ? 1 : undefined }}>
                  {agent().name}
                </Label>
                <Label size={10} tone="muted">
                  {agent().runtime === "eta"
                    ? uiText("etaBuiltIn")
                    : agent().runtime}
                </Label>
              </Checkbox>
            )}
          </Each>
          <If when={!candidates().length}>
            <Label tone="muted">{uiText("allAgentsAreAlreadyMembers")}</Label>
          </If>
        </Scroll>
      </View>
      <View
        style={{
          ...row,
          justifyContent: "flex-end",
          padding: 14,
          gap: 8,
          marginTop: phone() ? 0 : 4,
          borderTopWidth: phone() ? 1 : 0,
          borderColor: c().border,
        }}
      >
        <If when={!phone() && candidates().length && !inviteIds().length}>
          <Label size={10} tone="muted" style={{ flex: 1 }}>
            {formatLocale().startsWith("zh")
              ? "勾选要邀请的智能体"
              : "Tick the agents to invite"}
          </Label>
        </If>
        <Button
          label={uiText("cancel")}
          size={28}
          tone={phone() ? "ghost" : "plain"}
          disabled={saving()}
          onPress={props.onClose}
        />
        <Button
          label={uiText("invite", { length: inviteIds().length })}
          tone="primary"
          size={28}
          disabled={saving() || !inviteIds().length}
          onPress={() => void invite()}
        />
      </View>
    </>
  );
  return (
    <If
      when={props.layout === "tablet"}
      else={
        <Modal
          title={title()}
          width={384}
          height={phone() ? 380 : undefined}
          phone={phone()}
          sheet={phone()}
          hideHeader={!phone()}
          overPhoneNavigation
          dismissible={!saving()}
          onClose={props.onClose}
        >
          {content()}
        </Modal>
      }
    >
      <Dialog
        accessibilityLabel={title()}
        animation="none"
        style={fill}
        backdropStyle={{ backgroundColor: c().modalShade }}
        closeOnEscape={!saving()}
        closeOnBackdropPress={!saving()}
        onOpenChange={({ open }) => {
          if (!open && !saving()) props.onClose();
        }}
      >
        <View
          role="dialog"
          accessibilityLabel={title()}
          style={{
            position: "absolute",
            ...placement(),
            width: 384,
            maxWidth: "100%",
            borderWidth: 1,
            borderColor: c().border,
            backgroundColor: c().canvas,
          }}
        >
          {content()}
        </View>
      </Dialog>
    </If>
  );
}

export function Conversation(props: {
  id: string;
  layout: Layout;
  captain?: boolean;
  onBack?: () => void;
  onTask: (id: string) => void;
  onRelatedTask: (id: string) => void;
  onRoutines: (id?: string) => void;
  contentWidth?: number;
  alignComposer?: boolean;
  rail?: boolean;
  taskId?: string;
  onCloseTask: () => void;
}) {
  const host = useHost();
  const c = colors();
  const panel = signal<PanelTab>("Context");
  const drawer = signal(false);
  const invite = signal(false);
  const actions = signal(false);
  const projectInfo = signal(false);
  const member = signal<{ id: string; session: string }>();
  const memberSteps = signal("");
  const artifactSearch = signal("");
  const artifactOffset = signal(0);
  const preview = signal<{ artifact: ArtifactView; version?: number }>();
  const openArtifact = (artifact: ArtifactView, version?: number) =>
    preview.set({ artifact, version });
  const widgetDraft = signal<
    { conversationId: string; text: string } | undefined
  >(undefined);
  let transcriptList: ListRef | undefined;
  const markedMessage = signal("");
  const older = signal<MessageView[]>([]);
  const hasOlder = signal<boolean | undefined>(undefined);
  const paging = signal(false);
  const model = signal("");
  const target = () => `conversations.${props.id}`;
  follow(target);
  const reloadArtifacts = follow(() => "artifacts");
  const info = () => host.section<ConversationInfo>(target(), "info");
  const summary = () =>
    host.conversations().find((item) => item.id === props.id);
  const members = () =>
    host.section<MemberView[]>(target(), "members") ??
    summary()?.participants ??
    [];
  const title = () =>
    info()?.name ?? summary()?.name ?? (props.captain ? "Captain" : "Chat");
  const group = () => (info()?.kind ?? summary()?.kind) === "group";
  const project = () =>
    host
      .projects()
      .find((item) => item.id === (info()?.projectId ?? summary()?.projectId));
  const stewardId = () => (info() ? info()!.stewardId : summary()?.stewardId);
  const timeline = () => host.section<TimelineSection>(target(), "timeline");
  const messages = () => [
    ...new Map(
      [...older(), ...(timeline()?.messages ?? [])].map((message) => [
        message.id,
        message,
      ]),
    ).values(),
  ];
  const pending = () =>
    host.pending().filter((entry) => entry.conversationId === props.id);
  const indexed = computed(() => indexInserts(messages()));
  const inserting = signal<
    { message: MessageView; recipients: string[] } | undefined
  >(undefined);
  const lateInsert = signal(false);
  const tasks = () =>
    host.tasks().filter((entry) => entry.conversationId === props.id);
  const artifacts = () =>
    host.artifacts().filter((entry) => entry.conversationId === props.id);
  const needsAttention = () =>
    pending().length +
    tasks().filter(taskNeedsAttention).length +
    host
      .list<CaptainOperationView>("captain", "operations")
      .filter(
        (op) =>
          op.status === "pending" &&
          op.requiresApproval &&
          op.payload.originConversationId === props.id,
      ).length;
  const matchingArtifacts = () =>
    artifacts().filter((item) =>
      item.title.toLowerCase().includes(artifactSearch().trim().toLowerCase()),
    );
  const artifactsInPanel = () =>
    panel() === "Artifacts"
      ? matchingArtifacts().slice(artifactOffset(), artifactOffset() + 10)
      : artifacts().slice(0, 4);
  const newArtifactDay = (entry: ArtifactView, index: number) => {
    if (panel() !== "Artifacts") return false;
    const previous = artifactsInPanel()[index - 1];
    return (
      !previous ||
      new Date(previous.updatedAt).toDateString() !==
        new Date(entry.updatedAt).toDateString()
    );
  };
  const phone = () => props.layout === "phone";
  const offline = () => phone() && host.state().status === "reconnecting";
  const noCachedMessages = () => offline() && !messages().length;
  let previousRead = 0;
  effect(() => {
    const visible = timeline()?.messages.at(-1)?.seq;
    if (
      !visible ||
      visible <= previousRead ||
      !summary()?.unread ||
      host.state().status !== "open"
    )
      return;
    previousRead = visible;
    void host
      .call("conversations", "read", { conversationId: props.id, seq: visible })
      .catch(() => {
        if (previousRead === visible) previousRead = 0;
      });
  });

  async function history() {
    if (paging()) return;
    paging.set(true);
    const page = await host.action(() =>
      host.call<HistoryResult>("conversations", "history", {
        conversationId: props.id,
        beforeSeq: messages()[0]?.seq,
      }),
    );
    if (page) {
      older.update((list) => [...page.messages, ...list]);
      hasOlder.set(page.hasMore);
    }
    paging.set(false);
  }
  function Panel() {
    return (
      <If when={props.taskId} else={<PanelTabs />}>
        <Each of={props.taskId ? [props.taskId] : []}>
          {(id) => (
            <TaskDetail
              id={id()}
              layout={props.layout}
              docked
              onClose={props.onCloseTask}
              onTask={props.onRelatedTask}
            />
          )}
        </Each>
      </If>
    );
  }
  function PanelTabs() {
    return (
      <View style={{ ...grow, backgroundColor: c().surface }}>
        <View
          style={{
            ...row,
            justifyContent: "center",
            gap: 2,
            height: 40,
            flexShrink: 0,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <View
            style={{
              ...row,
              gap: 2,
              padding: 2,
              backgroundColor: c().selected,
            }}
          >
            <Each of={panelTabs}>
              {(tab) => {
                const selected = () => panel() === tab()[0];
                return (
                  <View
                    role="button"
                    accessibilityLabel={uiText(tab()[2])}
                    accessibilityState={{ selected: selected() }}
                    onPress={() => panel.set(tab()[0])}
                    hoverStyle={{ backgroundColor: c().canvas }}
                    style={{
                      ...row,
                      gap: 6,
                      height: 24,
                      paddingHorizontal: 10,
                      cursor: "pointer",
                      backgroundColor: selected() ? c().canvas : c().selected,
                    }}
                  >
                    <Icon
                      name={tab()[1]}
                      size={12}
                      tone={selected() ? "ink" : "muted"}
                    />
                    <If when={selected()}>
                      <Label size={11} line={16}>
                        {uiText(tab()[2])}
                      </Label>
                    </If>
                    <If when={tab()[0] === "Pending" && needsAttention()}>
                      <Label size={11} line={16} tone="muted">
                        {needsAttention()}
                      </Label>
                    </If>
                  </View>
                );
              }}
            </Each>
          </View>
          <If when={drawer() && !phone()}>
            <Button
              label={uiText("close")}
              icon="close"
              iconOnly
              tone="ghost"
              onPress={() => drawer.set(false)}
              style={{ position: "absolute", right: 8 }}
            />
          </If>
        </View>
        <If
          when={panel() === "Pending"}
          else={
            <Scroll style={grow} scrollbar={false}>
              <If when={props.captain && panel() === "Context"}>
                <View style={{ padding: 12, gap: 5 }}>
                  <Caption text={uiText("captainModel")} />
                  <View style={{ ...row, gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <ModelSelect
                        value={model() || host.captain()?.model || ""}
                        onChange={model.set}
                      />
                    </View>
                    <Button
                      label={uiText("saveModel")}
                      tone="primary"
                      disabled={!model()}
                      onPress={() =>
                        void host.action(async () => {
                          await host.call("captain", "setModel", {
                            model: model(),
                          });
                          model.set("");
                        })
                      }
                    />
                  </View>
                  <Label size={10} tone="muted">
                    {uiText("chooseTheModelUsedForCaptains")}
                  </Label>
                </View>
              </If>
              <If
                when={
                  panel() === "Tasks" ||
                  (panel() === "Context" && !props.captain)
                }
              >
                <View
                  style={{
                    paddingTop: 9,
                    paddingBottom: 3,
                    paddingHorizontal: 12,
                  }}
                >
                  <Caption
                    text={uiText("tasksWithCount", { length: tasks().length })}
                  />
                </View>
                <Each
                  of={panel() === "Context" ? tasks().slice(0, 6) : tasks()}
                  key={(task) => task.id}
                >
                  {(task) => (
                    <View
                      role="button"
                      onPress={() => props.onTask(task().id)}
                      hoverStyle={{ backgroundColor: c().selected }}
                      style={{
                        ...row,
                        height: 30,
                        paddingHorizontal: 12,
                        gap: 8,
                        borderBottomWidth: 1,
                        borderColor: c().border,
                        cursor: "pointer",
                      }}
                    >
                      <TaskGlyph status={task().status} size={12} />
                      <Label size={10} tone="muted">
                        {`#${task().number}`}
                      </Label>
                      <Label size={12} lines={1} style={{ flex: 1 }}>
                        {task().title}
                      </Label>
                      <TaskStatus task={task()} />
                      <Icon name="right" size={8} tone="faint" />
                    </View>
                  )}
                </Each>
                <If when={!tasks().length}>
                  <Label
                    size={12}
                    tone="muted"
                    style={{ paddingHorizontal: 12, paddingBottom: 8 }}
                  >
                    {uiText("noTasksYet")}
                  </Label>
                </If>
              </If>
              <If when={panel() === "Context" || panel() === "Artifacts"}>
                <View
                  style={{
                    paddingTop: 12,
                    borderBottomWidth: panel() === "Context" ? 1 : 0,
                    borderColor: c().border,
                  }}
                >
                  <Caption
                    text={uiText("artifacts", { length: artifacts().length })}
                    style={{ marginHorizontal: 12, marginBottom: 4 }}
                  />
                  <If when={panel() === "Artifacts" && artifacts().length}>
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
                      when={panel() === "Artifacts"}
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
                            onPress={reloadArtifacts}
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
                          placement={
                            panel() === "Artifacts" ? "list" : "context"
                          }
                          phone={phone()}
                          onPress={() => openArtifact(artifact())}
                          onTask={props.onTask}
                        />
                      </>
                    )}
                  </Each>
                  <If
                    when={
                      panel() === "Artifacts" && matchingArtifacts().length > 10
                    }
                  >
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
                          artifactOffset.update((value) =>
                            Math.max(0, value - 10),
                          )
                        }
                      />
                      <Button
                        label={uiText("next")}
                        disabled={
                          artifactOffset() + 10 >= matchingArtifacts().length
                        }
                        onPress={() =>
                          artifactOffset.update((value) => value + 10)
                        }
                      />
                    </View>
                  </If>
                </View>
              </If>
              <If when={panel() === "Context"}>
                <View
                  style={{
                    ...row,
                    justifyContent: "space-between",
                    height: 37,
                    paddingHorizontal: 12,
                    borderBottomWidth: 1,
                    borderColor: c().border,
                  }}
                >
                  <Label size={12} tone="muted">
                    {uiText(
                      members().length === 1
                        ? "oneConversationMember"
                        : "conversationMembers",
                      {
                        count: members().length,
                      },
                    )}
                  </Label>
                  <View style={{ ...row }}>
                    <If when={group()}>
                      <Button
                        label={uiText("invite2")}
                        tone="ghost"
                        disabled={info()?.archived}
                        onPress={() => invite.set(true)}
                      />
                    </If>
                    <Button
                      label={uiText("conversationActions")}
                      icon="more"
                      iconOnly
                      tone="ghost"
                      disabled={!info()}
                      onPress={() => actions.set(true)}
                    />
                  </View>
                </View>
                <Each of={members()} key={(entry) => entry.agentId}>
                  {(entry) => (
                    <View
                      style={{ borderBottomWidth: 1, borderColor: c().border }}
                    >
                      <View
                        style={{
                          ...row,
                          alignItems: "flex-start",
                          padding: 12,
                          gap: 12,
                          minHeight: 76,
                        }}
                      >
                        <View
                          style={{
                            padding: 5,
                            borderWidth: 1,
                            borderColor: c().border,
                            borderRadius: 20,
                          }}
                        >
                          <AgentFace id={entry().agentId} size={26} />
                        </View>
                        <View style={{ flex: 1, gap: 2 }}>
                          <View style={{ ...row, gap: 7 }}>
                            <Label>
                              {host.agent(entry().agentId)?.name ??
                                uiText("agent")}
                            </Label>
                            <View
                              style={{
                                width: 6,
                                height: 6,
                                backgroundColor: activeReply(entry().status)
                                  ? c().blue
                                  : c().strong,
                              }}
                            />
                            <Label size={10} tone="muted">
                              {memberStatus(entry().status)}
                            </Label>
                          </View>
                          <Label size={10} tone="muted">
                            {host.agent(entry().agentId)?.model ??
                              (entry().sessionId
                                ? uiText("defaultModel")
                                : uiText("noConversationYet"))}
                          </Label>
                        </View>
                        <If when={entry().sessionId}>
                          {(session) => (
                            <View style={{ ...row, gap: 6 }}>
                              <MemberStepsToggle
                                session={session()}
                                open={memberSteps() === session()}
                                onToggle={() =>
                                  memberSteps.set(
                                    memberSteps() === session()
                                      ? ""
                                      : session(),
                                  )
                                }
                              />
                              <Button
                                label={uiText("inspectRun")}
                                onPress={() =>
                                  member.set({
                                    id: entry().agentId,
                                    session: session(),
                                  })
                                }
                              />
                            </View>
                          )}
                        </If>
                      </View>
                      <If
                        when={
                          entry().sessionId &&
                          memberSteps() === entry().sessionId
                        }
                      >
                        <MemberStepsLedger
                          session={entry().sessionId!}
                          phone={phone()}
                        />
                      </If>
                    </View>
                  )}
                </Each>
              </If>
            </Scroll>
          }
        >
          <Pending
            conversationId={props.id}
            layout={props.layout}
            onTask={props.onTask}
            onRoutines={props.onRoutines}
          />
        </If>
      </View>
    );
  }
  return (
    <View style={{ ...row, ...grow, alignItems: "stretch" }}>
      <View style={grow}>
        <Header
          title={title()}
          layout={props.layout}
          onBack={props.onBack}
          inset={10}
        >
          <If when={!phone() && project() && group()}>
            <Button
              label={project()?.name ?? ""}
              icon="folder"
              tone="ghost"
              onPress={() => {
                panel.set("Context");
                if (props.layout === "desktop") projectInfo.set(true);
                else drawer.set(true);
              }}
            />
          </If>
          <If when={!phone() && group()}>
            <StewardMenu
              conversationId={props.id}
              members={members()}
              current={stewardId()}
            />
          </If>
          <If when={!phone()}>
            <View style={{ ...row, gap: 8 }}>
              <Each of={members()} key={(entry) => entry.agentId}>
                {(entry) => <AgentFace id={entry().agentId} size={12} />}
              </Each>
            </View>
          </If>
          <View style={{ flex: 1 }} />
          <If when={props.layout !== "desktop"}>
            <Button
              label={phone() ? uiText("conversationInfo") : uiText("panel")}
              icon={phone() ? "info" : "sidebar"}
              iconOnly={phone()}
              tone={phone() ? "ghost" : "plain"}
              onPress={() => drawer.set(true)}
            />
          </If>
        </Header>
        <If when={offline()}>
          <View
            role="alert"
            style={{
              ...row,
              paddingVertical: 8,
              paddingHorizontal: 14,
              gap: 8,
              backgroundColor: c().amberFill,
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <Icon name="info" tone="amber" size={13} />
            <Label size={12} line={15} tone="amber" style={{ flex: 1 }}>
              {uiText("connectionLostReconnectingWhatYouSee")}
            </Label>
          </View>
        </If>
        <View
          style={{
            ...grow,
            width: "100%",
            maxWidth: props.contentWidth,
            alignSelf: "center",
          }}
        >
          <If
            when={timeline() && !noCachedMessages()}
            else={
              <If
                when={noCachedMessages()}
                else={<Empty title={uiText("loadingConversation")} />}
              >
                <Empty
                  title={uiText("lostTheConnectionToTheHost")}
                  description={uiText("agentsKeepRunningOnTheHost")}
                  icon="refresh"
                >
                  <Button
                    label={uiText("retry")}
                    icon="refresh"
                    onPress={host.reconnect}
                  />
                </Empty>
              </If>
            }
          >
            <View style={{ ...grow, position: "relative" }}>
              <List
                style={grow}
                ref={(node) => {
                  transcriptList = node;
                }}
                each={indexed().rows}
                keyExtractor={(message) => message.id}
                initialScrollAtEnd
                estimatedItemSize={134}
                maintainVisibleContentPosition={{
                  autoscrollToBottomThreshold: 40,
                }}
                scrollbar={false}
                contentStyle={{
                  paddingLeft: 16,
                  paddingRight: props.rail ? 60 : 16,
                  paddingTop: phone() ? 16 : 12,
                  paddingBottom: 12,
                  gap: 12,
                }}
                header={() => (
                  <If when={hasOlder() ?? timeline()?.hasMore}>
                    <View style={{ alignItems: "center" }}>
                      <Button
                        label={uiText("loadEarlierMessages")}
                        disabled={paging()}
                        onPress={() => void history()}
                      />
                    </View>
                  </If>
                )}
                empty={() => (
                  <Label tone="muted" style={{ padding: 16 }}>
                    {uiText("noMessagesYet")}
                  </Label>
                )}
              >
                {(message) => (
                  <Message
                    item={message()}
                    additions={indexed().additions.get(message().id) ?? []}
                    canInsert={
                      host.state().status === "open" &&
                      indexed().recipients.has(message().id)
                    }
                    onInsert={() => {
                      lateInsert.set(false);
                      inserting.set({
                        message: message(),
                        recipients:
                          indexed().recipients.get(message().id) ?? [],
                      });
                    }}
                    phone={phone()}
                    compact={props.layout === "tablet" || props.alignComposer}
                    members={members()}
                    onTask={(id) => {
                      props.onTask(id);
                      if (!phone()) drawer.set(true);
                    }}
                    onArtifact={openArtifact}
                    onWidgetDraft={(text) =>
                      widgetDraft.set({
                        conversationId: message().conversationId,
                        text,
                      })
                    }
                  />
                )}
              </List>
              <If when={props.rail && messages().length}>
                <View
                  style={{
                    position: "absolute",
                    top: 10,
                    right: 10,
                    flexDirection: "row",
                    gap: 3,
                  }}
                >
                  <Each of={["assistant", "user"] as const}>
                    {(author) => {
                      const entries = () =>
                        indexed()
                          .rows.map((message, index) => ({ message, index }))
                          .filter((entry) => entry.message.author === author())
                          .slice(-12);
                      return (
                        <View style={{ gap: 3 }}>
                          <Each
                            of={entries()}
                            key={(entry) => entry.message.id}
                          >
                            {(entry, index) => (
                              <Button
                                label={`${author() === "user" ? "Prompt" : "Reply"} ${index() + 1}`}
                                size={20}
                                iconOnly
                                selected={
                                  markedMessage() === entry().message.id
                                }
                                icon={author() === "user" ? "chat" : "info"}
                                tone="ghost"
                                onPress={() => {
                                  markedMessage.set(entry().message.id);
                                  transcriptList?.scrollToIndex({
                                    index: entry().index,
                                    viewPosition: 0,
                                    animated: true,
                                  });
                                }}
                              />
                            )}
                          </Each>
                        </View>
                      );
                    }}
                  </Each>
                </View>
              </If>
            </View>
          </If>
          <If when={lateInsert()}>
            <View style={{ ...row, paddingHorizontal: 12, gap: 8 }}>
              <Label size={12} tone="muted" style={{ flex: 1 }}>
                {uiText("theTurnEndedYourAdditionWas")}
              </Label>
              <Button
                label={uiText("dismiss")}
                tone="ghost"
                onPress={() => lateInsert.set(false)}
              />
            </View>
          </If>
          <Composer
            id={props.id}
            name={title()}
            members={members()}
            steward={stewardId()}
            group={group()}
            phone={phone()}
            alignWithContent={props.alignComposer}
            held={timeline()?.held ?? []}
            widgetDraft={widgetDraft()}
          />
        </View>
      </View>
      <If when={props.layout === "desktop"}>
        <View
          style={{
            width: sizes.panel,
            borderLeftWidth: 1,
            borderColor: c().border,
            flexShrink: 0,
          }}
        >
          <Panel />
        </View>
      </If>
      <If
        when={drawer() && !invite() && !preview() && props.layout !== "desktop"}
      >
        <Modal
          title={phone() ? uiText("conversationInfo") : uiText("panel")}
          width={360}
          side={!phone()}
          hideHeader={!phone()}
          blurBackdrop={false}
          overPhoneNavigation={!phone()}
          height={phone() ? "70%" : "100%"}
          phone={phone()}
          onClose={() => {
            drawer.set(false);
            member.set(undefined);
            props.onCloseTask();
          }}
        >
          <Panel />
        </Modal>
      </If>
      <If when={inserting()}>
        {(entry) => (
          <InsertMessage
            message={entry().message}
            initialRecipients={entry().recipients}
            recipients={() =>
              indexed().recipients.get(entry().message.id) ?? []
            }
            phone={phone()}
            onLate={() => lateInsert.set(true)}
            onClose={() => inserting.set(undefined)}
          />
        )}
      </If>
      <If when={projectInfo() && project()}>
        <Modal
          title={project()?.name ?? uiText("directory")}
          width={400}
          onClose={() => projectInfo.set(false)}
        >
          <Label style={{ padding: 16 }}>
            {project()?.display ?? project()?.path}
          </Label>
        </Modal>
      </If>
      <If when={actions() ? info() : undefined}>
        {(active) => (
          <ConversationActions
            info={active()}
            members={members()}
            captain={props.captain}
            phone={phone()}
            onClose={() => actions.set(false)}
          />
        )}
      </If>
      <If when={invite()}>
        <InviteAgents
          conversationId={props.id}
          members={members()}
          layout={props.layout}
          onClose={() => invite.set(false)}
        />
      </If>
      <If when={member()}>
        <Modal
          title={uiText("runTranscript")}
          width={
            props.layout === "desktop"
              ? 960
              : Math.max(0, windowSize().width - 144)
          }
          height={
            phone()
              ? "100%"
              : Math.max(
                  0,
                  windowSize().height - (props.layout === "desktop" ? 100 : 48),
                )
          }
          phone={phone()}
          phonePage={phone()}
          hideHeader={!phone()}
          blurBackdrop={props.layout === "desktop"}
          overPhoneNavigation
          onClose={() => member.set(undefined)}
        >
          <MemberRun
            session={member()!.session}
            agentId={member()!.id}
            phone={phone()}
            reply={messages().findLast(
              (message) =>
                message.author === "agent" && message.agentId === member()!.id,
            )}
            onClose={() => member.set(undefined)}
          />
        </Modal>
      </If>
      <If when={preview()}>
        {(selection) => (
          <ArtifactPreview
            artifact={selection().artifact}
            initialVersion={selection().version}
            layout={props.layout}
            onClose={() => preview.set(undefined)}
          />
        )}
      </If>
    </View>
  );
}
