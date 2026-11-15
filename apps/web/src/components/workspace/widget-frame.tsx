import { useEffect, useRef, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  APP_FONT,
  appFontData,
  WIDGET_MESSAGE,
  WIDGET_SHELL,
  widgetTheme,
} from "./widget-shell";

/** Rapid stream updates are drawn at most this often. */
const STREAM_EVERY_MS = 150;
/** Below this there is no tag worth drawing yet (a stray `<d`). */
const MIN_CODE = 20;

/**
 * A widget the agent drew, beside its answer (`show_widget`). One frame for its whole life: the
 * code is sent to it as it streams and again, final, when the call is done, which is when its
 * scripts run. It is as tall as what it draws, follows the app's theme, and a `sendPrompt` in it
 * sends that text to the conversation.
 */
export function WidgetFrame({
  title,
  code,
  streaming,
  onPrompt,
}: {
  title: string;
  code: string;
  streaming: boolean;
  onPrompt: (text: string) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [height, setHeight] = useState(0);
  const promptRef = useRef(onPrompt);
  useEffect(() => {
    promptRef.current = onPrompt;
  });

  useEffect(() => {
    const frameWindow = frameRef.current?.contentWindow;
    const post = (message: object) =>
      frameRef.current?.contentWindow?.postMessage(
        { type: WIDGET_MESSAGE, ...message },
        "*",
      );
    const onMessage = (event: MessageEvent) => {
      // Only this frame's messages: every widget in the chat posts to the same window.
      if (event.source !== frameWindow || event.data?.type !== WIDGET_MESSAGE)
        return;
      const message = event.data as {
        kind?: string;
        height?: unknown;
        text?: unknown;
      };
      if (message.kind === "ready") {
        post({ kind: "theme", ...widgetTheme() });
        setReady(true);
        appFontData().then(
          (data) => post({ kind: "font", family: APP_FONT.family, data }),
          // The widget still draws, in a fallback face.
          (error: unknown) => console.error("widget font", error),
        );
      } else if (
        message.kind === "height" &&
        typeof message.height === "number"
      )
        setHeight(message.height);
      else if (message.kind === "prompt" && typeof message.text === "string")
        promptRef.current(message.text);
    };
    window.addEventListener("message", onMessage);
    // The app switches theme by the root's class.
    const theme = new MutationObserver(() =>
      post({ kind: "theme", ...widgetTheme() }),
    );
    theme.observe(document.documentElement, { attributeFilter: ["class"] });
    return () => {
      window.removeEventListener("message", onMessage);
      theme.disconnect();
    };
  }, []);

  // The newest code, sent at most every STREAM_EVERY_MS while it streams (a timer that restarted on
  // every update would draw nothing until the model paused), and at once when it is final.
  const latestRef = useRef(code);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    latestRef.current = code;
    if (!ready || code.length < MIN_CODE) return;
    const send = (final: boolean) =>
      frameRef.current?.contentWindow?.postMessage(
        {
          type: WIDGET_MESSAGE,
          kind: "content",
          html: latestRef.current,
          final,
        },
        "*",
      );
    if (!streaming) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
      send(true);
      return;
    }
    timerRef.current ??= setTimeout(() => {
      timerRef.current = undefined;
      send(false);
    }, STREAM_EVERY_MS);
  }, [ready, code, streaming]);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const drawn = ready && height > 0;
  return (
    <figure
      className="relative min-w-0"
      aria-label={title}
      aria-busy={streaming}
    >
      {drawn ? null : <Skeleton className="h-24" />}
      <iframe
        ref={frameRef}
        title={title}
        // Scripts, but no origin: the code cannot reach the app, its cookies or its API.
        sandbox="allow-scripts"
        srcDoc={WIDGET_SHELL}
        className="block w-full border-0"
        style={drawn ? { height } : { position: "absolute", height: 0 }}
      />
    </figure>
  );
}
