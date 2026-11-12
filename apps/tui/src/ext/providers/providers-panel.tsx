import type {
  LlmAccounts,
  LlmConnection,
  LlmConnector,
} from "@eta/client-contracts";
import type { PickItem } from "../kit/pick-list";
import { LLM_PROVIDER_ID } from "@eta/client-contracts";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useInputActive, useShell, useTheme } from "../../extensions/react";
import { useMessages } from "../../i18n/react";
import { inkColor } from "../../ui/theme";
import { usableModels, useModels } from "../kit/models";
import { PickList } from "../kit/pick-list";
import { useMounted, useTarget } from "../kit/wire-hooks";
import { AccountMenu, RemoveConfirm } from "./account-actions";
import { stateLabel } from "./accounts";
import { ApiKeyLogin } from "./api-key-login";
import { DeviceLogin } from "./device-login";
import { providersMessages } from "./messages";

/** An extra first row of the list, for a screen that shows the accounts as one of its steps. */
export interface LeadingItem {
  label: string;
  /** Set when the row cannot be chosen now: drawn under the list as the reason. */
  blockedReason?: string;
  onPick: () => void;
}

type View =
  | { name: "list" }
  | { name: "account"; connection: LlmConnection }
  | { name: "remove"; connection: LlmConnection }
  | { name: "login"; connector: LlmConnector };

const LEADING_KEY = "leading";
const CONNECTION = "connection:";
const CONNECTOR = "connector:";

/**
 * The model gateway's accounts: how many models are usable, the connected accounts, and a row to
 * connect each kind of account the gateway has. Choosing a row opens what it needs (an account's
 * actions, a sign-in, a key) in place; Esc there comes back here, and Esc here calls `onLeave`.
 */
export function ProvidersPanel({
  onLeave,
  leading,
}: {
  onLeave: () => void;
  leading?: LeadingItem;
}) {
  const shell = useShell();
  const t = useMessages(providersMessages);
  const gateway = useMounted(LLM_PROVIDER_ID);
  const llm = useTarget(
    gateway.mounted && gateway.error === undefined
      ? LLM_PROVIDER_ID
      : undefined,
  );
  const accounts = llm?.sections.accounts as LlmAccounts | undefined;
  const [view, setView] = useState<View>({ name: "list" });
  const [lastKey, setLastKey] = useState<string>();
  const toList = () => setView({ name: "list" });
  const connectorOf = (id: string) =>
    accounts?.connectors.find((connector) => connector.id === id);

  switch (view.name) {
    case "account": {
      // The live account when it is still listed; what was picked otherwise.
      const connection =
        accounts?.connections.find((c) => c.id === view.connection.id) ??
        view.connection;
      const connector = connectorOf(connection.connector);
      return (
        <AccountMenu
          connection={connection}
          connector={connector}
          onBack={toList}
          onRelogin={() => {
            if (connector !== undefined) setView({ name: "login", connector });
          }}
          onRemove={() => setView({ name: "remove", connection })}
        />
      );
    }
    case "remove":
      return (
        <RemoveConfirm
          connection={view.connection}
          onBack={() =>
            setView({ name: "account", connection: view.connection })
          }
          onRemoved={() => {
            shell.notify(t("removed", { account: view.connection.label }));
            toList();
          }}
        />
      );
    case "login":
      return (
        <ConnectorLogin
          connector={view.connector}
          onBack={toList}
          onConnected={() => {
            shell.notify(t("connected", { name: view.connector.name }));
            toList();
          }}
        />
      );
    case "list":
      return (
        <AccountList
          gateway={gateway}
          accounts={accounts}
          leading={leading}
          initialKey={lastKey}
          onLeave={onLeave}
          onPick={(key) => {
            setLastKey(key);
            if (key === LEADING_KEY) leading?.onPick();
            const connection = accounts?.connections.find(
              (c) => `${CONNECTION}${c.id}` === key,
            );
            if (connection !== undefined)
              setView({ name: "account", connection });
            const connector = accounts?.connectors.find(
              (c) => `${CONNECTOR}${c.id}` === key,
            );
            if (connector !== undefined) setView({ name: "login", connector });
          }}
        />
      );
  }
}

/** The sign-in a connector takes. */
function ConnectorLogin({
  connector,
  onBack,
  onConnected,
}: {
  connector: LlmConnector;
  onBack: () => void;
  onConnected: () => void;
}) {
  switch (connector.flow) {
    case "oauth_device":
      return (
        <DeviceLogin
          connector={connector}
          onBack={onBack}
          onConnected={onConnected}
        />
      );
    case "api_key":
      return (
        <ApiKeyLogin
          connector={connector}
          onBack={onBack}
          onConnected={onConnected}
        />
      );
    case "oauth_redirect":
      return <DesktopOnly connector={connector} onBack={onBack} />;
  }
}

/** A sign-in that returns to the desktop app's address, which a terminal cannot receive. */
function DesktopOnly({
  connector,
  onBack,
}: {
  connector: LlmConnector;
  onBack: () => void;
}) {
  const t = useMessages(providersMessages);
  const theme = useTheme();
  const active = useInputActive();
  useInput(
    (_input, key) => {
      if (key.escape) onBack();
    },
    { isActive: active },
  );
  return (
    <Box flexDirection="column">
      <Text bold>{t("connect", { name: connector.name })}</Text>
      <Box marginY={1}>
        <Text>{t("redirect", { name: connector.name })}</Text>
      </Box>
      <Text color={inkColor(theme.muted)}>{t("backFooter")}</Text>
    </Box>
  );
}

function AccountList({
  gateway,
  accounts,
  leading,
  initialKey,
  onLeave,
  onPick,
}: {
  gateway: { mounted: boolean; error: string | undefined };
  accounts: LlmAccounts | undefined;
  leading: LeadingItem | undefined;
  initialKey: string | undefined;
  onLeave: () => void;
  onPick: (key: string) => void;
}) {
  const t = useMessages(providersMessages);
  const theme = useTheme();
  const active = useInputActive();
  const models = useModels();
  useInput(
    (_input, key) => {
      if (key.escape) onLeave();
    },
    { isActive: active },
  );
  const muted = inkColor(theme.muted);
  const connectorName = (id: string) =>
    accounts?.connectors.find((c) => c.id === id)?.name ?? id;
  const leadingItems: PickItem[] =
    leading === undefined
      ? []
      : [
          {
            key: LEADING_KEY,
            label: leading.label,
            disabled: leading.blockedReason !== undefined,
          },
        ];
  const accountItems: PickItem[] =
    accounts === undefined || !accounts.ready
      ? []
      : [
          ...accounts.connections.map((connection) => ({
            key: `${CONNECTION}${connection.id}`,
            label: connection.label,
            hint: [
              connectorName(connection.connector),
              stateLabel(t, connection.state),
              ...(connection.plan === undefined ? [] : [connection.plan]),
            ].join(" · "),
          })),
          ...accounts.connectors.map((connector) => ({
            key: `${CONNECTOR}${connector.id}`,
            label: t("connect", { name: connector.name }),
          })),
        ];

  return (
    <Box flexDirection="column">
      <Text>
        {models === undefined
          ? t("modelsLoading")
          : t("usableModels", { count: usableModels(models).length })}
      </Text>
      <Box flexDirection="column" marginY={1}>
        <GatewayNotice gateway={gateway} accounts={accounts} />
        <PickList
          items={[...leadingItems, ...accountItems]}
          empty=""
          initialKey={initialKey}
          onPick={onPick}
        />
        {leading?.blockedReason !== undefined && (
          <Text color={muted}>{leading.blockedReason}</Text>
        )}
      </Box>
      <Text color={muted}>{t("listFooter")}</Text>
    </Box>
  );
}

/** Why there are no accounts to list: no gateway on this host, one that failed, or one starting. */
function GatewayNotice({
  gateway,
  accounts,
}: {
  gateway: { mounted: boolean; error: string | undefined };
  accounts: LlmAccounts | undefined;
}) {
  const t = useMessages(providersMessages);
  const theme = useTheme();
  if (!gateway.mounted)
    return (
      <Box flexDirection="column">
        <Text>{t("noGateway")}</Text>
        <Text color={inkColor(theme.muted)}>{t("configHint")}</Text>
      </Box>
    );
  if (gateway.error !== undefined)
    return (
      <Text color={inkColor(theme.error)}>
        {t("gatewayFailed", { error: gateway.error })}
      </Text>
    );
  if (accounts === undefined || !accounts.ready)
    return <Text color={inkColor(theme.muted)}>{t("gatewayStarting")}</Text>;
  return null;
}
