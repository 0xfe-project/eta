/** The screens of the phases before and around the shell. Each draws one phase of the controller. */
import type { ReactNode } from "react";
import type {
  ConnectionController,
  ConnectionPhase,
} from "../../connection/types";
import { Spinner } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { useInputActive, useTheme } from "../../extensions/react";
import { useMessages } from "../../i18n/react";
import { ChoiceList } from "../components/choice-list";
import { OutputTail } from "../components/output-tail";
import { Splash } from "../splash";
import { inkColor } from "../theme";
import { AddressForm } from "./address-form";
import { screenMessages } from "./messages";

type PhaseOf<N extends ConnectionPhase["name"]> = Extract<
  ConnectionPhase,
  { name: N }
>;

/** Rows the screens leave for the footer line under them. */
const FOOTER_ROWS = 1;

function Screen({ children }: { children: ReactNode }) {
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1} flexGrow={1}>
      {children}
    </Box>
  );
}

function Title({ children }: { children: ReactNode }) {
  return (
    <Box marginBottom={1}>
      <Text bold>{children}</Text>
    </Box>
  );
}

function Muted({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return <Text color={inkColor(theme.muted)}>{children}</Text>;
}

function useAnyKey(action: () => void): void {
  const active = useInputActive();
  useInput(() => action(), { isActive: active });
}

/** `idle`, `connecting`, `starting-temporary` and `stopped`: the splash and what is happening. */
export function StartingScreen({
  phase,
  version,
}: {
  phase: PhaseOf<"idle" | "connecting" | "starting-temporary" | "stopped">;
  version: string;
}) {
  const t = useMessages(screenMessages);
  const status = (() => {
    switch (phase.name) {
      case "idle":
        return t("starting");
      case "connecting":
        return phase.temporary
          ? t("connectingTemporary", { url: phase.url })
          : t("connecting", { url: phase.url });
      case "starting-temporary":
        return t("startingTemporary");
      case "stopped":
        return t("stopped");
    }
  })();
  return (
    <Box flexGrow={1} justifyContent="center" alignItems="center">
      <Splash
        version={version}
        detail={<Muted>{status}</Muted>}
        compactDetail={status}
        reservedRows={FOOTER_ROWS}
      />
    </Box>
  );
}

export function FirstRunScreen({
  phase,
  controller,
}: {
  phase: PhaseOf<"first-run">;
  controller: ConnectionController;
}) {
  const t = useMessages(screenMessages);
  const [asking, setAsking] = useState(false);
  return (
    <Screen>
      <Title>{t("firstRunTitle")}</Title>
      {asking ? (
        <AddressForm
          controller={controller}
          initialUrl={phase.suggestedUrl ?? ""}
          onBack={() => setAsking(false)}
        />
      ) : (
        <>
          <ChoiceList
            choices={[
              { label: t("choiceResident"), hint: t("choiceResidentHint") },
              { label: t("choiceTemporary"), hint: t("choiceTemporaryHint") },
              { label: t("choiceInstall"), hint: t("choiceInstallHint") },
            ]}
            onChoose={(index) => {
              if (index === 0) setAsking(true);
              else if (index === 1)
                void controller.startTemporary({ persist: true });
              else void controller.installResident();
            }}
          />
          <Box marginTop={1}>
            <Muted>{t("choicesHelp", { count: 3 })}</Muted>
          </Box>
        </>
      )}
    </Screen>
  );
}

export function HostMissingScreen({
  phase,
  controller,
  platform,
}: {
  phase: PhaseOf<"host-missing">;
  controller: ConnectionController;
  platform: NodeJS.Platform;
}) {
  const t = useMessages(screenMessages);
  useAnyKey(() => void controller.dismissFailure());
  const installPath =
    platform === "win32"
      ? "%USERPROFILE%\\.eta\\bin\\eta-host.exe"
      : "~/.eta/bin/eta-host";
  return (
    <Screen>
      <Title>{t("hostMissingTitle")}</Title>
      <Text>
        {phase.wanted === "temporary"
          ? t("hostMissingTemporary")
          : t("hostMissingInstall")}
      </Text>
      <Box flexDirection="column" marginY={1} marginLeft={2}>
        <Text>• {t("hostMissingEnv")}</Text>
        <Text>• {t("hostMissingPath")}</Text>
        <Text>• {t("hostMissingInstallPath", { path: installPath })}</Text>
      </Box>
      <Muted>{t("anyKeyBack")}</Muted>
    </Screen>
  );
}

/**
 * A host already serves this computer's `~/.eta`, so none was started: connect to that one, or
 * go back. Connecting uses the token read from its token file; when there is none to read and the
 * host asks for one, the user pastes it.
 */
export function ExistingHostScreen({
  phase,
  controller,
}: {
  phase: PhaseOf<"existing-host">;
  controller: ConnectionController;
}) {
  const t = useMessages(screenMessages);
  const [connecting, setConnecting] = useState(false);
  const { token } = phase;
  return (
    <Screen>
      <Title>{t("existingHostTitle")}</Title>
      <Text>{phase.url}</Text>
      <Box flexDirection="column" marginY={1}>
        <Text>
          {phase.wanted === "temporary"
            ? t("existingHostNotTemporary")
            : t("existingHostNotInstall")}
        </Text>
        {token.kind === "unreadable" && (
          <Muted>
            {t("existingHostTokenUnreadable", { file: token.file })}
          </Muted>
        )}
      </Box>
      {connecting ? (
        <AddressForm
          controller={controller}
          initialUrl={phase.url}
          initialToken={token.kind === "read" ? token.value : ""}
          withToken={token.kind !== "none"}
          startAt={token.kind === "unreadable" ? "token" : "address"}
          autoSubmit={token.kind !== "unreadable"}
          onBack={() => setConnecting(false)}
        />
      ) : (
        <>
          <ChoiceList
            choices={[
              { label: t("choiceConnectExisting") },
              { label: t("choiceBack") },
            ]}
            onChoose={(index) => {
              if (index === 0) setConnecting(true);
              else void controller.dismissFailure();
            }}
          />
          <Box marginTop={1}>
            <Muted>{t("choicesHelp", { count: 2 })}</Muted>
          </Box>
        </>
      )}
    </Screen>
  );
}

export function InstallingScreen({ phase }: { phase: PhaseOf<"installing"> }) {
  const t = useMessages(screenMessages);
  return (
    <Screen>
      <Spinner
        label={
          phase.step === "running" ? t("installRunning") : t("installWaiting")
        }
      />
    </Screen>
  );
}

export function InstallFailedScreen({
  phase,
  controller,
}: {
  phase: PhaseOf<"install-failed">;
  controller: ConnectionController;
}) {
  const t = useMessages(screenMessages);
  const theme = useTheme();
  useAnyKey(() => void controller.dismissFailure());
  return (
    <Screen>
      <Box marginBottom={1}>
        <Text bold color={inkColor(theme.error)}>
          {t("installFailedTitle")}
        </Text>
      </Box>
      <Text>
        {t(
          phase.step === "running"
            ? "installFailedRunning"
            : "installFailedWaiting",
        )}
      </Text>
      <OutputTail output={phase.output} />
      <Box marginY={1}>
        <Text>{t("installFailedWayOut")}</Text>
      </Box>
      <Muted>{t("anyKeyBack")}</Muted>
    </Screen>
  );
}

/** Space around the word inside its frame, so it stands out as the one thing on screen. */
const BIG_TEXT_PADDING = 2;

/**
 * Covers the whole screen while the connection is being regained. It takes no keys: the parts
 * behind it are turned off, and only quitting still works.
 */
export function ReconnectingScreen({
  phase,
}: {
  phase: PhaseOf<"reconnecting">;
}) {
  const t = useMessages(screenMessages);
  const theme = useTheme();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - phase.since) / 1_000));
  return (
    <Box
      flexGrow={1}
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
    >
      <Box
        borderStyle="double"
        borderColor={inkColor(theme.warning)}
        paddingX={BIG_TEXT_PADDING * 2}
        paddingY={BIG_TEXT_PADDING - 1}
      >
        <Text bold color={inkColor(theme.warning)}>
          {t("reconnecting")}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Muted>{t("reconnectingDetail", { url: phase.url, seconds })}</Muted>
      </Box>
    </Box>
  );
}

export function UnauthorizedScreen({
  phase,
  controller,
}: {
  phase: PhaseOf<"unauthorized">;
  controller: ConnectionController;
}) {
  const t = useMessages(screenMessages);
  const theme = useTheme();
  return (
    <Screen>
      <Box marginBottom={1}>
        <Text bold color={inkColor(theme.error)}>
          {t("unauthorizedTitle", { url: phase.url })}
        </Text>
      </Box>
      <AddressForm
        controller={controller}
        initialUrl={phase.url}
        withToken
        startAt="token"
      />
    </Screen>
  );
}

export function UnreachableScreen({
  phase,
  controller,
  onQuit,
}: {
  phase: PhaseOf<"unreachable">;
  controller: ConnectionController;
  onQuit: () => void;
}) {
  const t = useMessages(screenMessages);
  const theme = useTheme();
  const [changing, setChanging] = useState(false);
  const why =
    phase.reason === "temporary-failed"
      ? t("unreachableTemporaryFailed")
      : phase.reason === "temporary-exited"
        ? t("unreachableTemporaryExited")
        : undefined;
  return (
    <Screen>
      <Box marginBottom={1} flexDirection="column">
        <Text bold color={inkColor(theme.error)}>
          {t("unreachableTitle")}
          {phase.url !== undefined ? `  ${phase.url}` : ""}
        </Text>
        {why !== undefined && <Text>{why}</Text>}
      </Box>
      {phase.output !== undefined && phase.output !== "" && (
        <Box marginBottom={1}>
          <OutputTail output={phase.output} />
        </Box>
      )}
      {changing ? (
        <AddressForm
          controller={controller}
          initialUrl={phase.url ?? ""}
          withToken
          onBack={() => setChanging(false)}
        />
      ) : (
        <>
          <ChoiceList
            choices={[
              {
                label: t("choiceUseTemporary"),
                hint: t("choiceUseTemporaryHint"),
              },
              { label: t("choiceChangeAddress") },
              { label: t("choiceQuit") },
            ]}
            onChoose={(index) => {
              if (index === 0)
                void controller.startTemporary({ persist: false });
              else if (index === 1) setChanging(true);
              else onQuit();
            }}
          />
          <Box marginTop={1}>
            <Muted>{t("choicesHelp", { count: 3 })}</Muted>
          </Box>
        </>
      )}
    </Screen>
  );
}
