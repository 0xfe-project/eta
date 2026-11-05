import type { PluginServerView } from "@eta/client-contracts";
import { useTranslation } from "react-i18next";

// What a plugin will run: shown before it is enabled, because a stdio server is the author's code
// on the user's machine and a remote one is an address values go to.

const transportKeys = {
  stdio: "stdio",
  "streamable-http": "http",
  sse: "sse",
} as const;

export function PluginServers({
  servers,
  label,
}: {
  servers: readonly PluginServerView[];
  label: string;
}) {
  const { t: translateText } = useTranslation(["plugins"] as const);
  if (servers.length === 0) return null;
  return (
    <ul aria-label={label} className="space-y-1">
      {servers.map((server) => (
        <li key={server.name} className="text-xs">
          <span className="font-medium">{server.name}</span>{" "}
          <span className="text-muted-foreground">
            {translateText(`transport.${transportKeys[server.transport]}`)}
          </span>
          <code className="mt-0.5 block font-mono break-all text-muted-foreground">
            {server.command === undefined
              ? server.url
              : server.command.join(" ")}
          </code>
          {server.env.length > 0 ? (
            <p className="text-muted-foreground">
              {translateText("servers.env", { names: server.env.join(", ") })}
            </p>
          ) : null}
          {server.headers.length > 0 ? (
            <p className="text-muted-foreground">
              {translateText("servers.headers", {
                names: server.headers.join(", "),
              })}
            </p>
          ) : null}
          {server.problem === null ? null : (
            <p className="text-destructive">{server.problem}</p>
          )}
        </li>
      ))}
    </ul>
  );
}
