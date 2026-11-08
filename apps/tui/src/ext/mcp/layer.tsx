import type {
  McpConnectionState,
  McpResults,
  McpServerRef,
  McpServerView,
} from "@eta/client-contracts";
import type { LayerHandle } from "../../extensions/types";
import type { Translate } from "../../i18n/messages";
import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { useShell, useTheme } from "../../extensions/react";
import { useMessages } from "../../i18n/react";
import { LayerFrame } from "../../ui/components/layer-frame";
import { inkColor } from "../../ui/theme";
import { connectionOrigin } from "../kit/connection";
import { useHostCall } from "../kit/host-call";
import { PickList } from "../kit/pick-list";
import { TextPrompt } from "../kit/text-prompt";
import { useTarget } from "../kit/wire-hooks";
import { mcpMessages } from "./messages";

type McpText = Translate<keyof (typeof mcpMessages)["en"]>;

const STATE_KEYS = {
  connected: "stateConnected",
  cached: "stateCached",
  "not-connected": "stateNotConnected",
  failed: "stateFailed",
  "needs-auth": "stateNeedsAuth",
  disabled: "stateDisabled",
} as const satisfies Record<McpConnectionState, string>;

function stateText(state: McpConnectionState, t: McpText): string {
  return t(STATE_KEYS[state]);
}

const sameServer = (view: McpServerView, ref: McpServerRef) =>
  view.agentId === ref.agentId && view.server === ref.server;

const keyOf = (ref: McpServerRef) => JSON.stringify([ref.agentId, ref.server]);

/** Every agent's MCP servers, and for the one opened, connecting and signing in. */
export function McpLayer({ handle }: { handle: LayerHandle }) {
  const servers = useTarget("mcp")?.sections.list as
    | McpServerView[]
    | undefined;
  const [opened, setOpened] = useState<McpServerRef>();
  if (opened !== undefined)
    return (
      <McpDetail
        target={opened}
        view={servers?.find((view) => sameServer(view, opened))}
        onBack={() => setOpened(undefined)}
      />
    );
  return (
    <McpList
      servers={servers}
      onOpen={setOpened}
      onClose={() => handle.close()}
    />
  );
}

function McpList({
  servers,
  onOpen,
  onClose,
}: {
  servers: McpServerView[] | undefined;
  onOpen: (ref: McpServerRef) => void;
  onClose: () => void;
}) {
  const t = useMessages(mcpMessages);
  const items = (servers ?? []).map((view) => ({
    key: keyOf(view),
    label: t("rowLabel", { agent: view.agentName, server: view.server }),
    hint: t("row", {
      state: stateText(view.state, t),
      count: view.toolCount,
    }),
    ...(view.auth === "needs_login" ? { tag: t("needsLogin") } : {}),
  }));
  return (
    <LayerFrame title={t("title")} footer={t("listFooter")}>
      <PickList
        items={items}
        empty={servers === undefined ? t("loading") : t("empty")}
        onPick={(key) => {
          const view = servers?.find((entry) => keyOf(entry) === key);
          if (view !== undefined)
            onOpen({ agentId: view.agentId, server: view.server });
        }}
        onKey={(_input, key) => {
          if (!key.escape) return false;
          onClose();
          return true;
        }}
      />
    </LayerFrame>
  );
}

type Action = "connect" | "reconnect" | "login";

interface PendingLogin {
  pendingId: string;
  authorizationUrl: string;
}

function McpDetail({
  target,
  view,
  onBack,
}: {
  target: McpServerRef;
  view: McpServerView | undefined;
  onBack: () => void;
}) {
  const t = useMessages(mcpMessages);
  const theme = useTheme();
  const ctx = useShell();
  const { busy, error, setError, run } = useHostCall();
  const [done, setDone] = useState<string>();
  const [login, setLogin] = useState<PendingLogin>();
  const muted = inkColor(theme.muted);
  const auth = view?.auth;

  const [finished, setFinished] = useState<string>();

  // The sign-in ends when the list says the server is signed in: the browser may have come back
  // to the host by itself, or the pasted address was accepted.
  if (login !== undefined && auth === "signed_in") {
    setLogin(undefined);
    setFinished(login.pendingId);
  }
  useEffect(() => {
    if (finished !== undefined)
      ctx.notify(t("signedIn", { server: target.server }));
  }, [finished, ctx, t, target.server]);

  const start = (action: Action) => {
    setDone(undefined);
    if (action === "login") {
      const redirectOrigin = connectionOrigin(ctx.connection);
      if (redirectOrigin === undefined) {
        setError(t("noOrigin"));
        return;
      }
      run(
        async () =>
          ctx.wire.call<McpResults["login"]>("mcp", "login", {
            ...target,
            redirectOrigin,
          }),
        setLogin,
      );
      return;
    }
    run(
      async () => ctx.wire.call<McpResults["connect"]>("mcp", action, target),
      (result) => {
        if (result.ok) setDone(t("connected"));
        else setError(result.message ?? undefined);
      },
    );
  };

  const completeLogin = (callbackUrl: string) => {
    if (login === undefined) return;
    run(async () =>
      ctx.wire.call("mcp", "completeLogin", {
        pendingId: login.pendingId,
        callbackUrl,
      }),
    );
  };

  if (login !== undefined)
    return (
      <LayerFrame title={target.server} footer={t("loginFooter")}>
        <Text>{t("loginOpen")}</Text>
        <Text color={inkColor(theme.accent)}>{login.authorizationUrl}</Text>
        <Box marginY={1}>
          <Text color={muted}>{t("loginPaste")}</Text>
        </Box>
        <TextPrompt
          label={t("loginLabel")}
          onSubmit={completeLogin}
          onCancel={() => {
            setError(undefined);
            setLogin(undefined);
          }}
          error={error}
          busy={busy ? t("loginSending") : undefined}
        />
      </LayerFrame>
    );

  const actions = [
    { key: "connect", label: t("connect") },
    { key: "reconnect", label: t("reconnect") },
    ...(auth === "needs_login" ? [{ key: "login", label: t("login") }] : []),
  ];

  return (
    <LayerFrame title={target.server} footer={t("detailFooter")}>
      {view === undefined ? (
        <Text color={muted}>{t("gone")}</Text>
      ) : (
        <>
          <Text>{t("agent", { agent: view.agentName })}</Text>
          <Text>{t("source", { source: view.source })}</Text>
          <Text>{t("transport", { transport: view.transport })}</Text>
          <Text>
            {t("status", {
              state: stateText(view.state, t),
              count: view.toolCount,
            })}
            {view.auth === "needs_login" && (
              <Text color={inkColor(theme.warning)}>
                {` · ${t("needsLogin")}`}
              </Text>
            )}
          </Text>
          {view.error !== null && (
            <Text color={inkColor(theme.error)}>
              {t("error", { error: view.error })}
            </Text>
          )}
        </>
      )}
      <Box marginTop={1} flexDirection="column">
        <PickList
          items={view === undefined ? [] : actions}
          empty=""
          onPick={(key) => start(key as Action)}
          onKey={(_input, key) => {
            if (!key.escape) return false;
            onBack();
            return true;
          }}
        />
      </Box>
      {busy && <Text color={muted}>{t("connecting")}</Text>}
      {done !== undefined && (
        <Text color={inkColor(theme.success)}>{done}</Text>
      )}
      {error !== undefined && (
        <Text color={inkColor(theme.error)}>{error}</Text>
      )}
    </LayerFrame>
  );
}
