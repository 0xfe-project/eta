import type { WebViewRef } from "nsh";
import { Buffer } from "buffer";
import { cleanup, signal, WebView } from "nsh";
import lexerAsset from "../../../../assets/artifact-pdf-module-lexer.txt?url";
import renderer from "../../../../assets/artifact-pdf-renderer.txt?url";
import { grow } from "../../../components";
import { EmptyState } from "../../../components/empty-state";
import { uiText } from "../../../i18n";
import { LOAD_PATIENCE_MS } from "../../../services/load-status";
import { artifactPdf, decodePdfPage } from "./pdf";
import {
  artifactDocumentOrigin,
  artifactPdfDocument,
  artifactResourcePrefix,
} from "./pdf-document";

export type CaptureArtifactPdf = (signal: AbortSignal) => Promise<Uint8Array>;

export class ArtifactPdfResourcesError extends Error {
  constructor() {
    super(uiText("artifactPdfResourcesError"));
  }
}

const maxDocumentBytes = 2 * 1024 * 1024;
const maxPdfBytes = 32 * 1024 * 1024;
const maxMessageSize = 2_501_000;
const maxResourceBytes = 8 * 1024 * 1024;
const allowedResourceBytes = 20 * 1024 * 1024;
const chunkBytes = 96 * 1024;

function checkCancelled(signal: AbortSignal) {
  if (signal.aborted) throw new Error(uiText("cancel"));
}

export function ArtifactPdfPreview(props: {
  url: URL;
  onCapture: (capture?: CaptureArtifactPdf) => void;
  onError: (message: string) => void;
}) {
  const html = signal("");
  const loading = new AbortController();
  const bridge = Array.from(
    crypto.getRandomValues(new Uint8Array(16)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  let sequence = 0;
  let resourceCount = 0;
  let resourceBytes = 0;
  let startup: ReturnType<typeof setTimeout> | undefined;
  let pending:
    | {
        id: number;
        complete: (reply?: { result?: unknown; problem?: string }) => void;
      }
    | undefined;
  let webView: WebViewRef | undefined;
  async function sendResource(id: number, asset: string) {
    const page = webView;
    if (!page || loading.signal.aborted) return;
    function send(packet: { part?: string; done?: boolean; mime?: string }) {
      if (!loading.signal.aborted)
        page!.postMessage(JSON.stringify({ bridge, assetId: id, ...packet }));
    }
    try {
      const address = new URL(asset);
      if (
        ++resourceCount > 192 ||
        !address.href.startsWith(artifactResourcePrefix(props.url)) ||
        address.username ||
        address.password ||
        address.hash
      )
        throw new Error("Artifact resource outside the allowed version");
      const result = await fetch(address, {
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.any([loading.signal, AbortSignal.timeout(10_000)]),
      });
      if (
        !result.ok ||
        Number(result.headers.get("content-length")) > maxResourceBytes
      )
        throw new Error("Artifact resource could not be retrieved");
      const bytes = new Uint8Array(await result.arrayBuffer());
      resourceBytes += bytes.byteLength;
      if (
        bytes.byteLength > maxResourceBytes ||
        resourceBytes > allowedResourceBytes
      )
        throw new Error("Artifact resource exceeds render limits");
      const type =
        result.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
      const mime = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(type)
        ? type
        : "application/octet-stream";
      for (
        let offset = 0;
        offset < bytes.byteLength && !loading.signal.aborted;
        offset += chunkBytes
      )
        send({
          part: Buffer.from(
            bytes.subarray(offset, offset + chunkBytes),
          ).toString("base64"),
        });
      send({ done: true, mime });
    } catch {
      send({ done: true });
    }
  }
  cleanup(() => {
    clearTimeout(startup);
    pending?.complete();
    loading.abort();
    props.onCapture(undefined);
  });

  async function readDocument() {
    // The fetches have no deadline of their own: one that hangs ends in "did not open", not in
    // "Opening preview…" for ever.
    startup = setTimeout(() => {
      loading.abort();
      props.onError(uiText("artifactPreviewLoadError"));
    }, LOAD_PATIENCE_MS);
    try {
      const [page, code, parser] = await Promise.all([
        fetch(props.url, {
          credentials: "omit",
          redirect: "error",
          signal: loading.signal,
        }),
        fetch(renderer, { signal: loading.signal }),
        fetch(lexerAsset, { signal: loading.signal }),
      ]);
      if (
        !page.ok ||
        !code.ok ||
        !parser.ok ||
        !page.headers.get("content-type")?.includes("text/html") ||
        Number(page.headers.get("content-length")) > maxDocumentBytes
      )
        throw new Error("Invalid artifact or renderer response");
      const [source, rasterizer, lexer] = await Promise.all([
        page.text(),
        code.text(),
        parser.text(),
      ]);
      if (source.length > maxDocumentBytes || !rasterizer || !lexer)
        throw new Error("Artifact document exceeds render limits");
      if (!loading.signal.aborted) {
        clearTimeout(startup);
        startup = setTimeout(
          () => props.onError(uiText("artifactPreviewLoadError")),
          20_000,
        );
        html.set(
          artifactPdfDocument(props.url, source, rasterizer, bridge, lexer),
        );
      }
    } catch {
      if (!loading.signal.aborted)
        props.onError(uiText("artifactPreviewLoadError"));
    }
  }
  void readDocument();

  async function query(
    view: WebViewRef,
    operation: "prepare" | "render" | "restore",
    index = 0,
    abort?: AbortSignal,
  ) {
    const id = ++sequence;
    const reply = await new Promise<
      { result?: unknown; problem?: string } | undefined
    >((resolve) => {
      const cancel = () => {
        if (pending?.id === id) pending.complete();
      };
      const timeout = setTimeout(
        cancel,
        operation === "restore" ? 2000 : 24_000,
      );
      pending = {
        id,
        complete(message) {
          clearTimeout(timeout);
          abort?.removeEventListener("abort", cancel);
          pending = undefined;
          resolve(message);
        },
      };
      if (abort?.aborted) {
        cancel();
        return;
      }
      abort?.addEventListener("abort", cancel, { once: true });
      view.postMessage(JSON.stringify({ bridge, id, operation, index }));
    });
    if (!reply || reply.problem) {
      if (reply?.problem === "too-many-pages")
        throw new Error(uiText("artifactPdfTooLarge"));
      if (reply?.problem === "missing-resources")
        throw new ArtifactPdfResourcesError();
      throw new Error(uiText("artifactPdfRenderError"));
    }
    return reply.result;
  }

  async function capture(signal: AbortSignal) {
    const view = webView;
    if (!view) throw new Error(uiText("artifactPdfRenderError"));
    checkCancelled(signal);
    try {
      const prepared = (await query(view, "prepare", 0, signal)) as
        | { pages?: number }
        | undefined;
      const total = prepared?.pages ?? 0;
      if (!Number.isInteger(total) || total < 1 || total > 60)
        throw new Error(uiText("artifactPdfRenderError"));
      let size = 0;
      const pages = [];
      for (let index = 0; index < total; index++) {
        checkCancelled(signal);
        const page = decodePdfPage(await query(view, "render", index, signal));
        size += page.bytes.byteLength;
        if (size > maxPdfBytes) throw new Error(uiText("artifactPdfTooLarge"));
        pages.push(page);
      }
      checkCancelled(signal);
      return artifactPdf(pages);
    } finally {
      await query(view, "restore").catch(() => {});
    }
  }

  return (
    <If
      when={html()}
      else={
        <EmptyState
          size="page"
          status="loading"
          loading={uiText("openingPreview")}
          error={null}
          empty={{ title: uiText("openingPreview") }}
        />
      }
    >
      <WebView
        baseUrl={artifactDocumentOrigin}
        html={html()}
        incognito
        style={grow}
        ref={(view) => {
          webView = view;
        }}
        onMessage={({ data }) => {
          if (data.length > maxMessageSize) return;
          try {
            const reply = JSON.parse(data) as {
              bridge?: string;
              id?: number;
              problem?: string;
              result?: unknown;
              ready?: boolean;
              asset?: string;
              loadError?: boolean;
            };
            if (reply.bridge !== bridge || loading.signal.aborted) return;
            if (reply.loadError === true) {
              clearTimeout(startup);
              props.onError(uiText("artifactPreviewLoadError"));
            } else if (
              typeof reply.asset === "string" &&
              Number.isSafeInteger(reply.id)
            ) {
              void sendResource(reply.id!, reply.asset);
            } else if (reply.ready === true) {
              clearTimeout(startup);
              props.onCapture(capture);
            } else if (reply.id === pending?.id) pending?.complete(reply);
          } catch {
            // Messages from the artifact do not carry the app's token.
          }
        }}
        onError={(error) => props.onError(error.message)}
      />
    </If>
  );
}
