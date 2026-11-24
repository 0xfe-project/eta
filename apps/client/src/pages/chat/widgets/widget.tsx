import type { RunBlock } from "@eta/client-contracts";
import type { WebViewRef } from "nsh";
import { cleanup, colorScheme, effect, signal, View, WebView } from "nsh";
import dwgBoldFile from "../../../../assets/AKRDWGSCNFM-Bold.woff2?url";
import dwgLightFile from "../../../../assets/AKRDWGSCNFM-Light.woff2?url";
import dwgFile from "../../../../assets/AKRDWGSCNFM-Regular.woff2?url";
import {
  appFont,
  Button,
  colors,
  fontFamily,
  Fonts,
  Label,
  monoFontFamily,
  Revealed,
  row,
  SkeletonBar,
} from "../../../components";
import { space } from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { widgetDocument } from "./widget-document";

const MAX_CODE = 60_000;
const MAX_HEIGHT = 1_200;
const STREAM_INTERVAL = 120;
const widgetMinHeight = 160;

/** The shipped faces by weight, as the app registers them (`theme.ts`). */
const appFaces = [
  { weight: 300, file: dwgLightFile },
  { weight: 400, file: dwgFile },
  { weight: 700, file: dwgBoldFile },
];

const appFontData = new Map<string, Promise<string>>();

/**
 * A shipped face as base64, read once for every widget. The frame may load fonts from `data:`
 * only, so the faces go in as bytes, as the web app's widget shell takes them: a widget drawn in a
 * system face would be a second typeface in the product, and one with a single face would draw its
 * bold text as a synthesized bold.
 */
function appFontBytes(file: string) {
  let data = appFontData.get(file);
  if (!data) {
    data = fetch(file)
      .then((response) => {
        if (!response.ok) throw new Error(`font: HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then((bytes) => Buffer.from(bytes).toString("base64"));
    data.catch(() => appFontData.delete(file));
    appFontData.set(file, data);
  }
  return data;
}

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
  const fonts = Fonts();
  const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const html = widgetDocument(token);
  const ready = signal(false);
  const height = signal(0);
  const problem = signal(false);
  const attempt = signal(0);
  let frame: WebViewRef | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let startup: ReturnType<typeof setTimeout> | undefined;
  let sent: { code: string; final: boolean } | undefined;
  let themeSent: string | undefined;
  let disposed = false;

  function armTimeout() {
    clearTimeout(startup);
    startup = setTimeout(() => {
      if (!ready()) problem.set(true);
    }, 8_000);
  }
  armTimeout();
  cleanup(() => {
    disposed = true;
    clearTimeout(startup);
    clearTimeout(timer);
  });

  function retryWidget() {
    problem.set(false);
    ready.set(false);
    height.set(0);
    sent = undefined;
    themeSent = undefined;
    attempt.update((n) => n + 1);
    armTimeout();
  }

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
    const sans = fontFamily(fonts().interface);
    const mono = monoFontFamily(fonts());
    const themeKey = JSON.stringify([theme, sans, mono]);
    if (themeKey !== themeSent) {
      themeSent = themeKey;
      post({
        kind: "theme",
        mode: colorScheme(),
        colors: {
          "--color-text-primary": theme.ink,
          "--color-text-secondary": theme.muted,
          "--color-background-primary": theme.canvas,
          "--color-background-secondary": theme.selected,
          "--color-border-primary": theme.strong,
          "--color-border-tertiary": theme.border,
          "--color-text-info": theme.blue,
          "--color-text-success": theme.green,
          "--color-text-warning": theme.warning,
          "--color-text-danger": theme.red,
          "--font-sans": sans,
          "--font-mono": mono,
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
      for (const { weight, file } of appFaces)
        appFontBytes(file).then(
          (data) => {
            if (!disposed)
              post({ kind: "font", family: appFont, weight, data });
          },
          (error: unknown) => console.error("eta widget: font", error),
        );
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
    <View style={{ alignSelf: "stretch", minWidth: 0, gap: space[4] }}>
      <If when={problem()}>
        <View
          style={{
            ...row,
            justifyContent: "space-between",
            gap: space[8],
            padding: space[12],
            borderWidth: 1,
            borderColor: c().border,
            backgroundColor: c().surface,
          }}
        >
          <Label variant="small" tone="muted" style={{ flex: 1 }}>
            {uiText("unavailable", { title: props.value.title })}
          </Label>
          <Button
            label={uiText("retry")}
            icon="refresh"
            onPress={retryWidget}
          />
        </View>
      </If>
      <If when={!problem() && !height()}>
        <View style={{ minHeight: widgetMinHeight }}>
          <Revealed>
            <View
              role="progressbar"
              accessibilityLabel={uiText("drawing", {
                title: props.value.title,
              })}
              accessibilityState={{ busy: true }}
            >
              <SkeletonBar width="100%" height={widgetMinHeight} />
            </View>
          </Revealed>
        </View>
      </If>
      <If when={!problem()}>
        <Each of={[attempt()]} key={(n) => String(n)}>
          {() => (
            <WebView
              accessibilityLabel={props.value.title}
              html={html}
              incognito
              style={{
                alignSelf: "stretch",
                height: Math.max(1, height()),
              }}
              ref={(node) => {
                frame = node;
              }}
              onMessage={receive}
              onError={() => problem.set(true)}
            />
          )}
        </Each>
      </If>
    </View>
  );
}
