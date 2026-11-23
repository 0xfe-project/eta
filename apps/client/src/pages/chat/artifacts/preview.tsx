import type { ArtifactResults, ArtifactView } from "@eta/client-contracts";
import type { WebViewRef } from "nsh";
import type { Layout } from "../../../components";
import type { CaptureArtifactPdf } from "./pdf-preview";
import {
  cleanup,
  Clipboard,
  computed,
  effect,
  openUrl,
  platform,
  signal,
  View,
  WebView,
  windowSize,
} from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  Empty,
  grow,
  Label,
  Modal,
  row,
} from "../../../components";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
import { createArtifactFileSaver } from "./file";
import { ArtifactPdfPreview, ArtifactPdfResourcesError } from "./pdf-preview";

import { ArtifactToolbar } from "./toolbar";

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

export function ArtifactPreview(props: {
  artifact: ArtifactView;
  initialVersion?: number;
  layout: Layout;
  onClose: () => void;
}) {
  const host = useHost();
  const c = colors();
  const phone = () => props.layout === "phone";
  const printsInFrame = platform.os === "web";
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
  function phoneMenu() {
    return (
      <ActionMenu
        label={uiText("artifactActions")}
        iconSize={20}
        triggerStyle={{ width: 40, height: 40, paddingHorizontal: 0 }}
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
      <ArtifactToolbar
        title={props.artifact.title}
        layout={props.layout}
        version={version()}
        versions={artifact().versions}
        item={Boolean(item())}
        hasViewer={item()?.viewer === "iframe"}
        previewReady={Boolean(url())}
        shared={Boolean(item()?.shareUrl)}
        sharing={busy()}
        exportDisabled={
          !url() ||
          (!printsInFrame && !pdfCapture()) ||
          exportingPdf() ||
          downloading()
        }
        downloading={downloading()}
        downloadDisabled={!item() || downloading() || exportingPdf()}
        onVersion={version.set}
        onShare={() =>
          item()?.shareUrl ? void unshare() : confirmingShare.set(true)
        }
        onExport={() => void exportPdf()}
        onDownload={() => void download()}
        onPreview={openPreview}
        onClose={props.onClose}
      />
      {files.writer()}
      <If when={downloadProblem()}>
        <View style={{ ...row, padding: 8, gap: 8 }}>
          <Label variant="small" style={{ flex: 1 }} tone="red">
            {downloadProblem()}
          </Label>
          <Button label={uiText("retry")} onPress={() => void download()} />
        </View>
      </If>
      <If when={files.savedPath()}>
        <View style={{ ...row, padding: 8, gap: 8 }}>
          <Label variant="small" style={{ flex: 1 }}>
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
            <Label variant="small" lines={1} style={{ flex: 1 }}>
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
            <Label variant="small">
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
