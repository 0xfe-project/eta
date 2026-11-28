import type { ArtifactResults, ArtifactView } from "@eta/client-contracts";
import type { WebViewRef } from "nsh";
import type { Layout } from "../../../components";
import type { ProgressHandle } from "../../../components/progress-notification";
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
  DetailSkeleton,
  fill,
  grow,
  Label,
  Modal,
  row,
} from "../../../components";
import { EmptyState } from "../../../components/empty-state";
import { settled } from "../../../components/pending";
import { startProgress } from "../../../components/progress-notification";
import { showToast } from "../../../components/toast";
import { icon, space } from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { readResponseBytes } from "../../../services/attachment-files";
import { useHost } from "../../../services/host";
import { problemText } from "../../../services/problem-text";
import { CopyButton } from "../../../ui";
import { createArtifactFileSaver, savedToDownloads } from "./file";
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
  /**
   * How the version shows:
   * - `frame` (the browser): an `html` page around a sandboxed iframe; Export PDF asks the frame
   *   to print itself (`eta:print`).
   * - `direct` (macOS, Windows, Linux, iOS, Android): the web view navigates to the `/preview/`
   *   page itself, as a browser tab would. The host's `Content-Security-Policy: sandbox` keeps it
   *   in an opaque origin all the same.
   * - `render` (HarmonyOS): the app fetches the page and renders it in its own document.
   *
   * Export PDF: the desktops run `print()` in the page (the system's print dialog). The phones'
   * web views print nothing, so there the app's own renderer (`ArtifactPdfPreview`) rasterizes the
   * page: always mounted in `render`, and in `direct` only while an export runs, under the page.
   */
  const mode: "frame" | "direct" | "render" =
    platform.os === "web"
      ? "frame"
      : platform.name === "harmonyos"
        ? "render"
        : "direct";
  const printsInPage =
    mode === "direct" &&
    (platform.os === "macos" ||
      platform.os === "windows" ||
      platform.os === "linux");
  const rendersOnDemand = mode === "direct" && !printsInPage;
  const version = signal(
    props.initialVersion ?? props.artifact.versions[0]?.number,
  );
  const artifact = () =>
    host.artifacts().find((item) => item.id === props.artifact.id) ??
    props.artifact;
  const item = () =>
    artifact().versions.find((entry) => entry.number === version());
  const url = signal<URL | undefined>(undefined);
  /** Why the preview did not open: the raw failure, or `noVersion` for an artifact with none. */
  const problem = signal<unknown>(undefined);
  const retry = signal(0);
  const busy = signal(false);
  const copied = signal(false);
  const confirmingShare = signal(false);
  const files = createArtifactFileSaver();
  const saveArtifactFile = files.save;
  const downloading = signal(false);
  const downloadProblem = signal("");
  let downloadRequest: AbortController | undefined;
  let downloadProgress: ProgressHandle | undefined;
  const viewer = computed(() => item()?.viewer);
  const previewSettled = settled(
    () => Boolean(url()) || Boolean(problem()) || viewer() === "download",
  );
  const pdfCapture = signal<CaptureArtifactPdf>();
  const exportingPdf = signal(false);
  const reloadingPdf = signal(false);
  let exportController: AbortController | undefined;
  let exportProgress: ProgressHandle | undefined;
  let frame: WebViewRef | undefined;
  /** The renderer is mounted for an export (`rendersOnDemand`). */
  const rendering = signal(false);
  let rendererWaiting:
    | {
        resolve: (capture: CaptureArtifactPdf) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  function captureReady(capture?: CaptureArtifactPdf) {
    pdfCapture.set(capture);
    if (capture) rendererWaiting?.resolve(capture);
  }
  function rendererFailed(message: string) {
    if (rendererWaiting) rendererWaiting.reject(new Error(message));
    else problem.set(message);
  }
  /** The renderer's capture, mounting it first where it renders only for an export. */
  async function openCapture(abort: AbortSignal) {
    const ready = pdfCapture();
    if (ready || !rendersOnDemand) return ready;
    return new Promise<CaptureArtifactPdf>((resolve, reject) => {
      function cancel() {
        settle();
        reject(new Error(uiText("cancel")));
      }
      function settle() {
        rendererWaiting = undefined;
        abort.removeEventListener("abort", cancel);
      }
      rendererWaiting = {
        resolve(capture) {
          settle();
          resolve(capture);
        },
        reject(error) {
          settle();
          reject(error);
        },
      };
      abort.addEventListener("abort", cancel, { once: true });
      rendering.set(true);
    });
  }
  cleanup(() => {
    exportController?.abort();
    exportProgress?.dismiss();
    downloadRequest?.abort();
    downloadProgress?.dismiss();
  });
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
      downloadProgress?.dismiss();
    });
    url.set(undefined);
    problem.set(undefined);
    copied.set(false);
    pdfCapture.set(undefined);
    downloadProblem.set("");
    files.savedPath.set("");
    exportController?.abort();
    exportProgress?.dismiss();
    if (kind !== "iframe") return;
    if (number === undefined) {
      problem.set("noVersion");
      return;
    }
    if (!address) {
      problem.set(new Error("not connected"));
      return;
    }
    void host
      .call<ArtifactResults["preview"]>("artifacts", "preview", {
        artifactId: props.artifact.id,
        version: number,
      })
      .then((result) => {
        if (active) url.set(hostUrl(result.url, "/preview/"));
      })
      .catch((error: unknown) => {
        if (active) problem.set(error ?? new Error("failed"));
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

  function retryPdf() {
    if (!reloadingPdf()) {
      void exportPdf();
      return;
    }
    exportController?.abort();
    exportingPdf.set(false);
    retry.update((attempt) => attempt + 1);
  }

  async function exportPdf() {
    if (downloading()) return;
    if (mode === "frame") {
      frame?.postMessage("eta:print");
      return;
    }
    if (printsInPage) {
      frame?.injectJavaScript("print()");
      return;
    }
    const number = version();
    if (
      (!pdfCapture() && !rendersOnDemand) ||
      number === undefined ||
      exportController
    )
      return;
    const controller = new AbortController();
    exportController = controller;
    exportingPdf.set(true);
    reloadingPdf.set(false);
    const progress = startProgress({
      id: `artifact-pdf-${props.artifact.id}-${number}`,
      icon: "file",
      title: uiText("exportPdf"),
      detail: props.artifact.title,
      onCancel: () => controller.abort(),
    });
    exportProgress = progress;
    try {
      const capture = await openCapture(controller.signal);
      if (!capture) throw new Error(uiText("artifactPdfRenderError"));
      const bytes = await capture(controller.signal);
      if (controller.signal.aborted) {
        progress.dismiss();
        return;
      }
      const savedFile = await saveArtifactFile(
        bytes,
        props.artifact.title,
        number,
        "pdf",
        controller.signal,
      );
      if (controller.signal.aborted) {
        progress.dismiss();
        return;
      }
      if (savedFile?.downloads) {
        progress.complete(savedToDownloads(savedFile));
        return;
      }
      const saved = files.savedPath();
      progress.complete({
        title: uiText("exportPdf"),
        detail: saved
          ? uiText("artifactSavedTo", { path: saved })
          : props.artifact.title,
        onOpen: saved
          ? () =>
              void host.action(async () => {
                await Clipboard.writeText(saved);
                showToast({ title: uiText("copied") });
              })
          : undefined,
        showWhenQuick: Boolean(saved),
      });
    } catch (error) {
      if (controller.signal.aborted) {
        progress.dismiss();
      } else {
        reloadingPdf.set(error instanceof ArtifactPdfResourcesError);
        progress.fail({
          title: uiText("exportPdf"),
          detail:
            error instanceof Error && error.message
              ? error.message
              : uiText("artifactPdfRenderError"),
          onRetry: retryPdf,
        });
      }
    } finally {
      exportingPdf.set(false);
      if (rendersOnDemand) rendering.set(false);
      if (exportController === controller) exportController = undefined;
      if (exportProgress === progress) exportProgress = undefined;
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
    const progress = startProgress({
      id: `artifact-zip-${props.artifact.id}-${current.number}`,
      icon: "download",
      title: uiText("download"),
      detail: props.artifact.title,
      onCancel: () => request.abort(),
    });
    downloadProgress = progress;
    try {
      const link = hostUrl(current.archiveUrl, "/artifacts/");
      if (platform.os === "web") {
        await openUrl(link.href);
        progress.dismiss();
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
      const bytes = await readResponseBytes(response, (fraction) =>
        progress.update({ progress: fraction }),
      );
      if (request.signal.aborted) {
        progress.dismiss();
        return;
      }
      const savedFile = await saveArtifactFile(
        bytes,
        props.artifact.title,
        current.number,
        "zip",
        request.signal,
      );
      if (request.signal.aborted) {
        progress.dismiss();
        return;
      }
      if (savedFile?.downloads) {
        progress.complete(savedToDownloads(savedFile));
        return;
      }
      const saved = files.savedPath();
      progress.complete({
        title: uiText("download"),
        detail: saved
          ? uiText("artifactSavedTo", { path: saved })
          : props.artifact.title,
        onOpen: saved
          ? () =>
              void host.action(async () => {
                await Clipboard.writeText(saved);
                showToast({ title: uiText("copied") });
              })
          : undefined,
        showWhenQuick: Boolean(saved),
      });
    } catch (error) {
      if (request.signal.aborted) {
        progress.dismiss();
      } else {
        const message = problemText(error);
        downloadProblem.set(message);
        progress.fail({
          title: uiText("download"),
          detail: message,
          onRetry: () => void download(),
        });
      }
    } finally {
      if (downloadRequest === request) {
        downloadRequest = undefined;
        downloading.set(false);
      }
      if (downloadProgress === progress) downloadProgress = undefined;
    }
  }
  function phoneMenu() {
    return (
      <ActionMenu
        label={uiText("artifactActions")}
        iconSize={icon.lg}
        triggerStyle={{
          width: space[40],
          height: space[40],
          paddingHorizontal: 0,
        }}
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
          (mode === "render" && !pdfCapture()) ||
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
        <View style={{ ...row, padding: space[8], gap: space[8] }}>
          <Label variant="small" style={{ flex: 1 }} tone="red">
            {downloadProblem()}
          </Label>
          <Button label={uiText("retry")} onPress={() => void download()} />
        </View>
      </If>
      <If when={files.savedPath()}>
        <View style={{ ...row, padding: space[8], gap: space[8] }}>
          <Label variant="small" style={{ flex: 1 }}>
            {uiText("artifactSavedTo", { path: files.savedPath() })}
          </Label>
          <CopyButton
            label={uiText("artifactCopyPath")}
            value={files.savedPath}
          />
        </View>
      </If>
      <If when={item()?.shareUrl}>
        {(shareUrl) => (
          <View
            style={{
              ...row,
              padding: space[8],
              gap: space[8],
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
        when={problem() !== undefined}
        else={
          <If
            when={previewSettled() ? url() : undefined}
            else={
              <EmptyState
                size="page"
                status={item()?.viewer === "download" ? "empty" : "loading"}
                loading={
                  <DetailSkeleton
                    label={uiText("openingPreview")}
                    style={grow}
                  />
                }
                error={null}
                empty={{
                  art: "artifacts",
                  title: uiText("availableAsAZipDownload"),
                }}
              />
            }
          >
            {(link) =>
              mode === "render" ? (
                <ArtifactPdfPreview
                  url={link()}
                  onCapture={captureReady}
                  onError={rendererFailed}
                />
              ) : mode === "direct" ? (
                <View style={grow}>
                  {/* The renderer lays the page out at its own width, so it can sit under the
                      page the user sees, for as long as an export needs it. */}
                  <If when={rendering()}>
                    <View style={fill}>
                      <ArtifactPdfPreview
                        url={link()}
                        onCapture={captureReady}
                        onError={rendererFailed}
                      />
                    </View>
                  </If>
                  <View style={fill}>
                    <WebView
                      src={link().href}
                      incognito
                      style={grow}
                      ref={(node) => {
                        frame = node;
                      }}
                      onError={(error) => problem.set(error)}
                    />
                  </View>
                </View>
              ) : (
                <WebView
                  html={previewDocument(link())}
                  incognito
                  style={grow}
                  ref={(node) => {
                    frame = node;
                  }}
                  onError={(error) => problem.set(error)}
                />
              )
            }
          </If>
        }
      >
        <EmptyState
          size="page"
          status="error"
          loading={null}
          error={{
            title: uiText("previewUnavailable"),
            description:
              problem() === "noVersion"
                ? uiText("previewNoVersion")
                : `${problemText(problem())} ${uiText("previewSafe")}`,
            problem: problem() === "noVersion" ? undefined : problem(),
            retry:
              problem() === "noVersion"
                ? undefined
                : () => retry.update((attempt) => attempt + 1),
            actions: url()
              ? [{ label: uiText("openInBrowser"), onPress: openPreview }]
              : undefined,
          }}
          empty={{ title: uiText("previewUnavailable") }}
        />
      </If>
      <If when={confirmingShare()}>
        <Modal
          title={uiText("shareThisVersionPublicly")}
          phone={phone()}
          sheet={phone()}
          onClose={() => confirmingShare.set(false)}
        >
          <View style={{ padding: space[16], gap: space[8] }}>
            <Label>{uiText("anyoneWithTheLinkCanOpen")}</Label>
            <View style={{ ...row, justifyContent: "flex-end", gap: space[8] }}>
              <Button
                label={uiText("cancel")}
                disabled={busy()}
                onPress={() => confirmingShare.set(false)}
              />
              <Button
                label={uiText("sharePublicly")}
                tone="primary"
                busy={busy()}
                onPress={() => void share()}
              />
            </View>
          </View>
        </Modal>
      </If>
    </Modal>
  );
}
