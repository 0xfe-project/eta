import type { RunBlock } from "@eta/client-contracts";
import type { WebViewRef } from "nsh";
import { cleanup, effect, signal, View, WebView } from "nsh";
import { colors, Label, palette } from "../../../components";
import { uiText } from "../../../i18n";
import { widgetDocument } from "./widget-document";

const MAX_CODE = 60_000;
const MAX_HEIGHT = 1_200;
const STREAM_INTERVAL = 120;

export function widgetFrom(block: RunBlock) {
  if (
    block.type !== "tool" ||
    block.name !== "show_widget" ||
    block.status === "failed"
  )
    return undefined;
  const source = (block.status === "completed" ? block.details : block.input) as
    | { widget_code?: unknown; title?: unknown }
    | undefined;
  const code = source?.widget_code;
  if (typeof code !== "string" || code.length > MAX_CODE || !code.trim())
    return undefined;
  return {
    id: block.id,
    title:
      typeof source?.title === "string" && source.title.trim()
        ? source.title
        : uiText("defaultWidgetTitle"),
    code,
    streaming: block.status === "running",
  };
}

export function Widget(props: {
  value: NonNullable<ReturnType<typeof widgetFrom>>;
  onDraft?: (text: string) => void;
}) {
  const c = colors();
  const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const html = widgetDocument(token);
  const ready = signal(false);
  const height = signal(0);
  const problem = signal(false);
  let frame: WebViewRef | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sent: { code: string; final: boolean } | undefined;
  let themeSent: ReturnType<typeof c> | undefined;
  let disposed = false;
  const startup = setTimeout(() => {
    if (!ready()) problem.set(true);
  }, 8_000);
  cleanup(() => {
    disposed = true;
    clearTimeout(startup);
    clearTimeout(timer);
  });

  function post(message: object) {
    frame?.postMessage(JSON.stringify({ token, message }));
  }
  function draw() {
    const { code, streaming } = props.value;
    const final = !streaming;
    if (sent?.code === code && sent.final === final) return;
    sent = { code, final };
    post({ kind: "content", html: code, final });
  }
  effect(() => {
    if (!ready()) return;
    const theme = c();
    if (theme !== themeSent) {
      themeSent = theme;
      post({
        kind: "theme",
        mode: theme.canvas === palette("dark").canvas ? "dark" : "light",
        colors: {
          "--color-text-primary": theme.ink,
          "--color-text-secondary": theme.muted,
          "--color-background-primary": theme.canvas,
          "--color-background-secondary": theme.selected,
          "--color-border-primary": theme.strong,
          "--color-border-tertiary": theme.border,
          "--color-text-info": theme.blue,
          "--color-text-success": theme.green,
          "--color-text-warning": theme.amber,
          "--color-text-danger": theme.red,
        },
      });
    }
    const { code, streaming } = props.value;
    if (!code) return;
    if (!streaming) {
      clearTimeout(timer);
      timer = undefined;
      draw();
    } else if (timer === undefined) {
      timer = setTimeout(() => {
        timer = undefined;
        draw();
      }, STREAM_INTERVAL);
    }
  });

  function receive({ data }: { data: string }) {
    if (disposed || data.length > 50_000) return;
    let result: unknown;
    try {
      result = JSON.parse(data);
    } catch {
      return;
    }
    const message = result as {
      token?: unknown;
      kind?: unknown;
      height?: unknown;
      text?: unknown;
    } | null;
    if (message?.token !== token) return;
    if (message.kind === "ready") {
      clearTimeout(startup);
      problem.set(false);
      ready.set(true);
    } else if (
      message.kind === "height" &&
      typeof message.height === "number" &&
      Number.isFinite(message.height)
    ) {
      height.set(Math.min(MAX_HEIGHT, Math.max(0, Math.ceil(message.height))));
    } else if (
      message.kind === "draft" &&
      typeof message.text === "string" &&
      message.text.length <= 8192
    ) {
      const text = message.text.trim();
      if (text) props.onDraft?.(text);
    }
  }

  return (
    <View style={{ alignSelf: "stretch", minWidth: 0, gap: 4 }}>
      <If when={problem() || !height()}>
        <Label size={11} tone="muted">
          {problem()
            ? uiText("unavailable", { title: props.value.title })
            : uiText("drawing", { title: props.value.title })}
        </Label>
      </If>
      <WebView
        accessibilityLabel={props.value.title}
        html={html}
        incognito
        style={{
          alignSelf: "stretch",
          height: problem() ? 1 : Math.max(1, height()),
        }}
        ref={(node) => {
          frame = node;
        }}
        onMessage={receive}
        onError={() => problem.set(true)}
      />
    </View>
  );
}
