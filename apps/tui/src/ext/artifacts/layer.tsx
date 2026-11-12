import type { ArtifactResults, ArtifactView } from "@eta/client-contracts";
import type { ConnectionController } from "../../connection/types";
import type { LayerHandle } from "../../extensions/types";
import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { agentsOf } from "../../extensions/eager-lists";
import { hostHas } from "../../extensions/host-ops";
import { useInputActive, useShell, useTheme } from "../../extensions/react";
import { useLocale, useMessages } from "../../i18n/react";
import { LayerFrame } from "../../ui/components/layer-frame";
import { useListHeight } from "../../ui/components/row-cursor";
import { RowList } from "../../ui/components/row-list";
import { inkColor } from "../../ui/theme";
import { copyToClipboard } from "../conversation/transcript/clipboard";
import { artifactMessages } from "./messages";
import { relativeTime } from "./relative-time";

const COMMAND = "artifacts";

/** The address of the host this connection is to, without a trailing slash. */
function hostOrigin(connection: ConnectionController): string {
  const { phase } = connection.getState();
  const url = "url" in phase ? (phase.url ?? "") : "";
  return url.replace(/\/+$/, "");
}

/** An address the host gave, made whole when it is a path on the host. */
function absolute(origin: string, address: string): string {
  return address.startsWith("/") ? `${origin}${address}` : address;
}

/** What Enter on an artifact shows. */
type Opened =
  | { kind: "download" }
  | { kind: "loading" }
  | { kind: "failed"; error: string }
  | { kind: "preview"; url: string };

/**
 * `/artifacts`: the artifacts the host has, newest first, followed while the layer is open.
 * Enter on one shows its newest version's preview address, which `y` copies; a kind the app only
 * downloads says so.
 */
export function ArtifactsLayer({ handle }: { handle: LayerHandle }) {
  const ctx = useShell();
  const { wire } = ctx;
  const t = useMessages(artifactMessages);
  const locale = useLocale();
  const theme = useTheme();
  const active = useInputActive();
  const height = useListHeight();

  useEffect(() => wire.subscribe("artifacts"), [wire]);
  const list = useStore(
    wire.store,
    (state) =>
      state.targets.artifacts?.sections.list as ArtifactView[] | undefined,
  );
  const agents = useStore(wire.store, agentsOf);
  const artifacts = (list ?? [])
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt);

  // Ages are counted from when the layer opened.
  const [now] = useState(() => Date.now());
  const [cursor, setCursor] = useState(0);
  const at = Math.min(cursor, Math.max(0, artifacts.length - 1));
  const [opened, setOpened] = useState<
    { artifact: ArtifactView; view: Opened } | undefined
  >();
  const askedRef = useRef(0);

  const open = (artifact: ArtifactView) => {
    const version = artifact.versions[0];
    if (version === undefined) return;
    if (version.viewer !== "iframe") {
      setOpened({ artifact, view: { kind: "download" } });
      return;
    }
    if (!hostHas(ctx, "artifacts.preview", COMMAND)) return;
    const request = ++askedRef.current;
    setOpened({ artifact, view: { kind: "loading" } });
    wire
      .call<ArtifactResults["preview"]>("artifacts", "preview", {
        artifactId: artifact.id,
        version: version.number,
      })
      .then(
        (result) => {
          if (request !== askedRef.current) return;
          setOpened({
            artifact,
            view: {
              kind: "preview",
              url: absolute(hostOrigin(ctx.connection), result.url),
            },
          });
        },
        (error: unknown) => {
          if (request !== askedRef.current) return;
          setOpened({
            artifact,
            view: {
              kind: "failed",
              error: error instanceof Error ? error.message : String(error),
            },
          });
        },
      );
  };

  useInput(
    (input, key) => {
      if (opened !== undefined) {
        if (key.escape) {
          askedRef.current += 1;
          setOpened(undefined);
        } else if (input === "y" && opened.view.kind === "preview") {
          copyToClipboard(opened.view.url);
          ctx.notify(t("copied"), "info");
        }
        return;
      }
      if (key.upArrow) setCursor(Math.max(0, at - 1));
      else if (key.downArrow)
        setCursor(Math.min(Math.max(0, artifacts.length - 1), at + 1));
      else if (key.return && artifacts[at] !== undefined) open(artifacts[at]);
      else if (key.escape) handle.close();
    },
    { isActive: active },
  );

  if (opened !== undefined) {
    const { artifact, view } = opened;
    const shareUrl = artifact.versions[0]?.shareUrl ?? null;
    return (
      <LayerFrame
        title={`${t("title")} · ${artifact.title}`}
        footer={view.kind === "preview" ? t("previewFooter") : t("plainFooter")}
      >
        {view.kind === "download" && <Text>{t("cannotPreview")}</Text>}
        {view.kind === "loading" && (
          <Text color={inkColor(theme.muted)}>{t("loading")}</Text>
        )}
        {view.kind === "failed" && (
          <Text color={inkColor(theme.error)}>{view.error}</Text>
        )}
        {view.kind === "preview" && (
          <Box flexDirection="column">
            <Text color={inkColor(theme.accent)}>{view.url}</Text>
            <Text color={inkColor(theme.muted)}>{t("validForAnHour")}</Text>
            {shareUrl !== null && (
              <Text>
                {t("publicAddress", {
                  url: absolute(hostOrigin(ctx.connection), shareUrl),
                })}
              </Text>
            )}
          </Box>
        )}
      </LayerFrame>
    );
  }

  return (
    <LayerFrame title={t("title")} footer={t("listFooter")}>
      {list === undefined ? (
        <Text color={inkColor(theme.muted)}>{t("loading")}</Text>
      ) : artifacts.length === 0 ? (
        <Text>{t("empty")}</Text>
      ) : (
        <RowList
          rows={artifacts.map((artifact) => {
            const publisher = agents.find(
              (agent) => agent.id === artifact.publisherAgentId,
            )?.name;
            const parts = [
              `v${artifact.versions[0]?.number ?? 0}`,
              ...(publisher === undefined ? [] : [publisher]),
              relativeTime(artifact.updatedAt, now, locale),
            ];
            return {
              key: artifact.id,
              label: artifact.title,
              note: parts.join("  "),
            };
          })}
          cursor={at}
          height={height}
        />
      )}
    </LayerFrame>
  );
}
