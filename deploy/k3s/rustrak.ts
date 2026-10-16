// Usage: bun deploy/k3s/rustrak.ts dsn|token
//
// Signs in to Rustrak (deploy/k3s/infra/rustrak.yaml) at RUSTRAK_URL as its
// administrator, RUSTRAK_SUPERUSER (email:password), and prints the DSN of
// its project `axp`, created when missing, or a new API token (what
// deploy.sh uploads the web's source maps with). scripts/dev.sh and
// deploy/k3s/deploy.sh run it; the values they keep never enter the
// repository.
import process from "node:process";

const [what] = process.argv.slice(2);
const url = process.env.RUSTRAK_URL;
const superuser = process.env.RUSTRAK_SUPERUSER ?? "";
if (!url || !superuser.includes(":") || (what !== "dsn" && what !== "token")) {
  console.error(
    "usage: RUSTRAK_URL=… RUSTRAK_SUPERUSER=email:password bun deploy/k3s/rustrak.ts dsn|token",
  );
  process.exit(2);
}

interface Project {
  slug: string;
  dsn: string;
}

async function signIn(): Promise<string> {
  const separator = superuser.indexOf(":");
  const login = await fetch(`${url}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: superuser.slice(0, separator),
      password: superuser.slice(separator + 1),
    }),
  });
  if (!login.ok) throw new Error(`Rustrak sign-in: ${login.status}`);
  return login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

async function main() {
  const cookie = await signIn();
  const api = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Rustrak ${path}: ${response.status}`);
    return (await response.json()) as T;
  };
  if (what === "token") {
    const { token } = await api<{ token: string }>("/api/tokens", {
      description: "AXP source maps (deploy/k3s/deploy.sh)",
    });
    return token;
  }
  const { items } = await api<{ items: Project[] }>(
    "/api/projects?per_page=100",
  );
  const project =
    items.find((p) => p.slug === "axp") ??
    (await api<Project>("/api/projects", { name: "axp" }));
  return project.dsn;
}

main().then(
  (value) => process.stdout.write(`${value}\n`),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
