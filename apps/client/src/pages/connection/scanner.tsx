import { cleanup, platform, signal, View, WebView } from "nsh";
import { BackHandler } from "nsh/mobile";
import decoder from "../../../assets/qr-decoder.txt?url";
import { fill, grow } from "../../components";
import { scannerDocument } from "./scanner-document";

const cameraOrigin = "https://eta-camera.invalid/";

export function Scanner(props: {
  onCode: (text: string) => void;
  onClose: () => void;
  onUnavailable: () => void;
}) {
  const html = signal("");
  let closed = false;
  cleanup(() => {
    closed = true;
  });
  if (platform.os === "android")
    cleanup(
      BackHandler.on("press", () => {
        props.onClose();
        return true;
      }),
    );
  function unavailable() {
    if (!closed) props.onUnavailable();
  }
  void fetch(decoder)
    .then(async (response) => {
      if (!response.ok) throw new Error("QR decoder unavailable");
      const source = await response.text();
      if (!closed) html.set(scannerDocument(source));
    })
    .catch(unavailable);
  return (
    <View
      style={{
        ...fill,
        // design-value: over the Connect page's own parts, under the dialogs it opens
        zIndex: 10,
        // design-value: the camera's backdrop is dark in either theme
        backgroundColor: "#0a0b0c",
      }}
    >
      <If when={html()}>
        <WebView
          baseUrl={cameraOrigin}
          html={html()}
          style={grow}
          incognito
          scrollable={false}
          onError={unavailable}
          onMessage={({ data }) => {
            if (closed || data.length > 8192) return;
            try {
              const result = JSON.parse(data) as {
                code?: string;
                close?: boolean;
              };
              if (typeof result.code === "string") props.onCode(result.code);
              else if (result.close) props.onClose();
              else unavailable();
            } catch {
              unavailable();
            }
          }}
        />
      </If>
    </View>
  );
}
