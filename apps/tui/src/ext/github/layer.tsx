import type {
  GitHubConnectionState,
  GitHubResults,
  GitHubStatus,
} from "@eta/client-contracts";
import type { LayerHandle } from "../../extensions/types";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useInputActive, useShell, useTheme } from "../../extensions/react";
import { useMessages } from "../../i18n/react";
import { LayerFrame } from "../../ui/components/layer-frame";
import { inkColor } from "../../ui/theme";
import { connectionOrigin } from "../kit/connection";
import { useHostCall } from "../kit/host-call";
import { useMounted, useTarget } from "../kit/wire-hooks";
import { githubMessages } from "./messages";

const STATE_KEYS = {
  not_connected: "stateNotConnected",
  not_installed: "stateNotInstalled",
  ready: "stateReady",
  error: "stateError",
} as const satisfies Record<GitHubConnectionState, string>;

/** The ready App has nobody authorized yet, and the host can ask GitHub for an authorization. */
function canAuthorize(status: GitHubStatus): boolean {
  return status.state === "ready" && status.user === null && status.oauth;
}

/** The GitHub App on this host: where it stands, and the steps a terminal can take. */
export function GitHubLayer({ handle }: { handle: LayerHandle }) {
  const t = useMessages(githubMessages);
  const theme = useTheme();
  const { mounted, error } = useMounted("github");
  const active = useInputActive();
  useInput(
    (_input, key) => {
      if (key.escape) handle.close();
    },
    { isActive: active && (!mounted || error !== undefined) },
  );
  if (!mounted)
    return (
      <LayerFrame title={t("title")} footer={t("footerClose")}>
        <Text>{t("notMounted")}</Text>
      </LayerFrame>
    );
  if (error !== undefined)
    return (
      <LayerFrame title={t("title")} footer={t("footerClose")}>
        <Text color={inkColor(theme.error)}>{t("mountError", { error })}</Text>
      </LayerFrame>
    );
  return <GitHubStatusView onClose={() => handle.close()} />;
}

function GitHubStatusView({ onClose }: { onClose: () => void }) {
  const t = useMessages(githubMessages);
  const theme = useTheme();
  const ctx = useShell();
  const active = useInputActive();
  const status = useTarget("github")?.sections.state as
    | GitHubStatus
    | undefined;
  const { busy, error: failure, setError: setFailure, run } = useHostCall();
  // What the running call is doing, drawn while it runs.
  const [doing, setDoing] = useState<string>();
  const [authorizeUrl, setAuthorizeUrl] = useState<string>();
  const muted = inkColor(theme.muted);
  const origin = connectionOrigin(ctx.connection);
  const authorizable = status !== undefined && canAuthorize(status);

  const call = <T,>(
    label: string,
    task: () => Promise<T>,
    done?: (value: T) => void,
  ) => {
    if (run(task, done)) setDoing(label);
  };

  useInput(
    (input, key) => {
      if (key.escape) {
        onClose();
        return;
      }
      if (input === "r") {
        call(t("checking"), async () =>
          ctx.wire.call("github", "refresh", { fresh: true }),
        );
      } else if (input === "a" && authorizable) {
        if (origin === undefined) {
          setFailure(t("noOrigin"));
          return;
        }
        call(
          t("authorizing"),
          async () =>
            ctx.wire.call<GitHubResults["authorize"]>("github", "authorize", {
              origin,
            }),
          (result) => setAuthorizeUrl(result.url),
        );
      }
    },
    { isActive: active },
  );

  if (status === undefined)
    return (
      <LayerFrame title={t("title")} footer={t("footer")}>
        <Text color={muted}>{t("loading")}</Text>
      </LayerFrame>
    );

  return (
    <LayerFrame
      title={t("title")}
      footer={authorizable ? t("footerAuthorize") : t("footer")}
    >
      <Text>{t("status", { state: t(STATE_KEYS[status.state]) })}</Text>
      {!status.checked && <Text color={muted}>{t("notChecked")}</Text>}
      {status.app !== null && (
        <Text>
          {t("app", { name: status.app.name, owner: status.app.owner })}
        </Text>
      )}
      {status.installations.length > 0 && (
        <Box flexDirection="column">
          <Text>{t("installedOn")}</Text>
          {status.installations.map((installation) => (
            <Text key={installation.id}>
              {"  "}
              {installation.repositorySelection === "all"
                ? t("allRepos", { account: installation.account })
                : t("someRepos", {
                    account: installation.account,
                    count: installation.totalRepositories,
                  })}
            </Text>
          ))}
        </Box>
      )}
      {status.app !== null && (
        <Text>
          {status.user === null
            ? t("noUser")
            : t("user", { login: status.user.login })}
        </Text>
      )}
      {status.error !== null && (
        <Text color={inkColor(theme.error)}>
          {t("error", { error: status.error.message })}
        </Text>
      )}
      <Box marginTop={1} flexDirection="column">
        <NextStep status={status} authorizeUrl={authorizeUrl} origin={origin} />
      </Box>
      {busy && <Text color={muted}>{doing}</Text>}
      {failure !== undefined && (
        <Text color={inkColor(theme.error)}>{failure}</Text>
      )}
    </LayerFrame>
  );
}

/** What the user can do next from a terminal, or where to go instead. */
function NextStep({
  status,
  authorizeUrl,
  origin,
}: {
  status: GitHubStatus;
  authorizeUrl: string | undefined;
  origin: string | undefined;
}) {
  const t = useMessages(githubMessages);
  const theme = useTheme();
  const link = inkColor(theme.accent);
  switch (status.state) {
    case "not_connected":
      return <Text>{t("createInBrowser")}</Text>;
    case "not_installed":
      return status.app === null ? null : (
        <>
          <Text>{t("installAt")}</Text>
          <Text color={link}>{status.app.installUrl}</Text>
        </>
      );
    case "error":
      return <Text>{t("errorHelp")}</Text>;
    case "ready":
      if (status.user !== null) return null;
      if (!status.oauth) return <Text>{t("noOAuth")}</Text>;
      if (authorizeUrl === undefined) return <Text>{t("offerAuthorize")}</Text>;
      return (
        <>
          <Text>{t("authorizeAt", { origin: origin ?? "" })}</Text>
          <Text color={link}>{authorizeUrl}</Text>
        </>
      );
  }
}
