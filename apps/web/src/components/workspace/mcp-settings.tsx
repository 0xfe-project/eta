import type { McpServerView } from "@eta/client-contracts";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/ArrowsClockwise";
import { PlugIcon } from "@phosphor-icons/react/Plug";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Empty, LoadError, Loading } from "@/components/states";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  useCompleteMcpLogin,
  useConnectMcp,
  useLoginMcp,
  useLogoutMcp,
  useMcpServers,
  useReconnectMcp,
} from "@/queries/mcp";
import { wireErrorMessage } from "@/queries/wire";

// Settings → MCP 服务器: every agent's servers by where they are declared, how each stands, and
// the sign-in of the ones that use OAuth. The page never holds a credential: signing in opens the
// provider's address in a new tab, and a host the browser cannot be sent back to is finished by
// pasting the address the provider ended on.

const stateKeys = {
  connected: "connected",
  cached: "cached",
  "not-connected": "notConnected",
  failed: "failed",
  "needs-auth": "needsAuth",
  disabled: "disabled",
} as const;

const showError = (error: Error) => toast.error(wireErrorMessage(error));

/** The sign-in of one server: the address was opened; this takes the redirect URL if it is pasted. */
function LoginDialog({
  server,
  pendingId,
  authorizationUrl,
  onClose,
}: {
  server: McpServerView;
  pendingId: string;
  authorizationUrl: string;
  onClose: () => void;
}) {
  const { t: translateText } = useTranslation(["mcp", "common"] as const);
  const complete = useCompleteMcpLogin();
  const [redirect, setRedirect] = useState("");
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {translateText("login.title", { server: server.server })}
          </DialogTitle>
          <DialogDescription>
            {translateText("login.description")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (redirect.trim() === "" || complete.isPending) return;
            complete.mutate(
              { pendingId, callbackUrl: redirect.trim() },
              {
                onSuccess: () => {
                  toast.success(
                    translateText("login.done", { server: server.server }),
                  );
                  onClose();
                },
                onError: showError,
              },
            );
          }}
        >
          <Input
            aria-label={translateText("login.redirect")}
            placeholder={translateText("login.redirectPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            value={redirect}
            onChange={(event) => setRedirect(event.target.value)}
          />
          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              className="text-muted-foreground sm:mr-auto"
              onClick={() =>
                window.open(authorizationUrl, "_blank", "noopener,noreferrer")
              }
            >
              {translateText("login.reopen")}
            </Button>
            <Button
              type="submit"
              disabled={redirect.trim() === "" || complete.isPending}
            >
              {translateText("login.finish")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ServerRow({ server }: { server: McpServerView }) {
  const { t: translateText } = useTranslation(["mcp", "common"] as const);
  const connect = useConnectMcp();
  const reconnect = useReconnectMcp();
  const login = useLoginMcp();
  const logout = useLogoutMcp();
  const [pending, setPending] = useState<{
    pendingId: string;
    authorizationUrl: string;
  } | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const ref = { agentId: server.agentId, server: server.server };
  const connected = server.state === "connected";
  const busy = connect.isPending || reconnect.isPending;

  const report = ({ ok, message }: { ok: boolean; message: string | null }) =>
    ok
      ? toast.success(translateText("connect.done", { server: server.server }))
      : toast.error(
          translateText("connect.failed", {
            server: server.server,
            message: message ?? "",
          }),
        );

  return (
    <li className="flex items-start gap-3 px-3 py-2 text-sm">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
          {server.server}
          <span className="text-xs font-normal text-muted-foreground">
            {translateText(`transport.${server.transport}`)} ·{" "}
            {server.lifecycle}
          </span>
          <Badge
            variant={
              server.state === "failed"
                ? "destructive"
                : connected
                  ? "default"
                  : "outline"
            }
          >
            {translateText(`state.${stateKeys[server.state]}`)}
          </Badge>
          {server.auth === "none" ? null : (
            <Badge variant="outline">
              {server.auth === "signed_in"
                ? translateText("auth.signedIn")
                : translateText("auth.needsLogin")}
            </Badge>
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          {translateText("summary.tools", { count: server.toolCount })}
        </p>
        {server.error === null ? null : (
          <p className="text-xs break-words text-destructive">{server.error}</p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap justify-end gap-1">
        {server.auth === "none" ? null : server.auth === "signed_in" ? (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`${translateText("actions.signOut")} ${server.server}`}
            onClick={() => setSigningOut(true)}
          >
            {translateText("actions.signOut")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`${translateText("actions.signIn")} ${server.server}`}
            disabled={login.isPending}
            onClick={() => {
              // Opened now, in the click, so a pop-up blocker allows it; pointed at the provider
              // when the host has the address. A blocked tab leaves the dialog's own button.
              const tab = window.open("about:blank", "_blank");
              if (tab) tab.opener = null;
              login.mutate(
                { ...ref, redirectOrigin: window.location.origin },
                {
                  onSuccess: (started) => {
                    setPending(started);
                    if (tab) tab.location.href = started.authorizationUrl;
                  },
                  onError: (error) => {
                    tab?.close();
                    showError(error);
                  },
                },
              );
            }}
          >
            {translateText("actions.signIn")}
          </Button>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`${translateText(connected ? "actions.reconnect" : "actions.connect")} ${server.server}`}
          title={translateText(
            connected ? "actions.reconnect" : "actions.connect",
          )}
          disabled={busy || server.state === "disabled"}
          onClick={() =>
            (connected ? reconnect : connect).mutate(ref, {
              onSuccess: report,
              onError: showError,
            })
          }
        >
          <ArrowsClockwiseIcon aria-hidden="true" />
        </Button>
      </div>
      {pending !== null && server.auth !== "signed_in" ? (
        <LoginDialog
          server={server}
          pendingId={pending.pendingId}
          authorizationUrl={pending.authorizationUrl}
          onClose={() => setPending(null)}
        />
      ) : null}
      <AlertDialog open={signingOut} onOpenChange={setSigningOut}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {translateText("logout.confirmTitle", { server: server.server })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {translateText("logout.confirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {translateText("common:actions.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                logout.mutate(ref, {
                  onSuccess: () =>
                    toast(
                      translateText("logout.done", { server: server.server }),
                    ),
                  onError: showError,
                })
              }
            >
              {translateText("actions.signOut")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

/** The servers of one agent, a group per place they are declared. */
function AgentServers({
  name,
  servers,
}: {
  name: string;
  servers: readonly McpServerView[];
}) {
  const sources = [...new Set(servers.map((server) => server.source))];
  return (
    <section aria-label={name} className="space-y-1">
      <h3 className="text-xs font-semibold">{name}</h3>
      {sources.map((source) => (
        <div key={source} className="border">
          <p className="border-b bg-muted/40 px-3 py-1 font-mono text-xs text-muted-foreground">
            {source}
          </p>
          <ul aria-label={`${name} ${source}`} className="divide-y">
            {servers
              .filter((server) => server.source === source)
              .map((server) => (
                <ServerRow
                  key={`${server.source}\0${server.server}`}
                  server={server}
                />
              ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** Settings → MCP 服务器. */
export function McpSettings() {
  const { t: translateText } = useTranslation(["mcp", "common"] as const);
  const { servers, loaded, error } = useMcpServers();
  const agents = [...new Set(servers.map((server) => server.agentId))];
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold">{translateText("title")}</h2>
      <p className="text-xs text-muted-foreground">
        {translateText("description")}
      </p>
      {error ? (
        <LoadError what={translateText("title")} error={error} />
      ) : !loaded ? (
        <Loading rows={3} />
      ) : servers.length === 0 ? (
        <Empty icon={PlugIcon} title={translateText("empty.title")}>
          {translateText("empty.description")}
        </Empty>
      ) : (
        agents.map((agentId) => {
          const own = servers.filter((server) => server.agentId === agentId);
          return (
            <AgentServers
              key={agentId}
              name={own[0]!.agentName}
              servers={own}
            />
          );
        })
      )}
    </div>
  );
}
