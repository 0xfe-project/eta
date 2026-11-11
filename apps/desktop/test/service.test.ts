/**
 * The app as its host's service, with a script standing in for the host: it prints a summary
 * line, answers `/up` on the port it was given, and writes down what it was started with.
 */
import type { ServiceServer } from "../src/bun/service";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOST_WRAPPER } from "../src/bun/host";
import {
  LocalHost,
  SERVICE_ENV,
  SERVICE_TOKEN_ENV,
  startServiceServer,
} from "../src/bun/service";

let dir: string;
let host: LocalHost | undefined;
let server: ServiceServer | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "eta-service-"));
});
afterEach(async () => {
  server?.close();
  await host?.stop();
  [host, server] = [undefined, undefined];
  await rm(dir, { recursive: true, force: true });
});

const FAKE_HOST = String.raw`
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ok") });
await Bun.write(process.env.STARTS + "/" + Date.now() + "-" + process.pid, JSON.stringify({
  service: process.env.ETA_DESKTOP_SERVICE ?? null,
  hasToken: (process.env.ETA_DESKTOP_SERVICE_TOKEN ?? "") !== "",
}));
console.log(JSON.stringify({ port: server.port }));
process.on("SIGTERM", () => { server.stop(true); process.exit(0); });
setInterval(() => {}, 1000);
`;

/** A job that writes its argv and environment where the test can read them, then waits. */
const FAKE_JOB = String.raw`
await Bun.write(process.env.JOB_OUT, JSON.stringify({
  argv: process.argv.slice(2),
  passed: process.env.PASSED ?? null,
  service: process.env.ETA_DESKTOP_SERVICE ?? null,
}));
process.on("SIGTERM", () => process.exit(130));
setInterval(() => {}, 1000);
`;

async function setUp() {
  const wrapper = join(dir, "wrapper.ts");
  const fake = join(dir, "host.ts");
  const starts = join(dir, "starts");
  await writeFile(wrapper, HOST_WRAPPER);
  await writeFile(fake, FAKE_HOST);
  const env: NodeJS.ProcessEnv = { ...process.env, STARTS: starts };
  await Bun.write(join(starts, ".keep"), "");
  host = new LocalHost({
    command: [process.execPath, fake],
    cwd: dir,
    env,
    wrapper,
    bun: process.execPath,
    summary: join(dir, "summary"),
  });
  // The job's program is the host's file; here a script bun runs, through a shebang-less stub.
  const program = join(dir, "eta-host");
  await writeFile(
    program,
    `#!/bin/sh\nexec ${process.execPath} ${join(dir, "job.ts")} "$@"\n`,
    {
      mode: 0o755,
    },
  );
  await writeFile(join(dir, "job.ts"), FAKE_JOB);
  server = startServiceServer({ host, program, dir, env });
  Object.assign(env, server.env);
  await host.spawn();
  const port = await host.ready();
  return { env: server.env, port, program, starts };
}

async function ask(
  env: Record<string, string>,
  path: string,
  body?: unknown,
  token = env[SERVICE_TOKEN_ENV],
): Promise<Response> {
  return await fetch(`${env[SERVICE_ENV]}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token ?? ""}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const up = async (port: number): Promise<boolean> =>
  await fetch(`http://127.0.0.1:${String(port)}/up`).then(
    (answer) => answer.ok,
    () => false,
  );

const until = async (ready: () => Promise<boolean>, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(50);
  }
};

describe("the app as the host's service", () => {
  it("tells the host where to find it, and only with the token", async () => {
    const { env, program, starts } = await setUp();
    const [first] = await Array.fromAsync(new Bun.Glob("*-*").scan(starts));
    const told = JSON.parse(
      await readFile(join(starts, first ?? ""), "utf8"),
    ) as {
      service: string;
      hasToken: boolean;
    };
    expect(told).toEqual({ service: env[SERVICE_ENV], hasToken: true });

    expect((await ask(env, "/service", undefined, "wrong")).status).toBe(401);
    const state = (await (await ask(env, "/service")).json()) as Record<
      string,
      unknown
    >;
    expect(state).toMatchObject({
      program,
      running: true,
      crashed: false,
    });
  });

  it("refuses a page: a browser says where it comes from", async () => {
    const { env } = await setUp();
    const answer = await fetch(`${env[SERVICE_ENV]}/service`, {
      headers: {
        authorization: `Bearer ${env[SERVICE_TOKEN_ENV] ?? ""}`,
        origin: "http://127.0.0.1:1234",
      },
    });
    expect(answer.status).toBe(403);
  });

  it("stops the host and starts it again on the same port", async () => {
    const { env, port } = await setUp();
    await ask(env, "/service/stop", {});
    expect(await up(port)).toBe(false);
    const stopped = (await (await ask(env, "/service")).json()) as {
      running: boolean;
      crashed: boolean;
    };
    // Stopped on purpose is not a crash: the upgrade's watch tells the two apart.
    expect(stopped).toMatchObject({ running: false, crashed: false });

    await ask(env, "/service/start", {});
    await until(() => up(port));
    expect(host?.port).toBe(port);
  });

  it("says a host that exited by itself crashed", async () => {
    const { env, starts } = await setUp();
    const [name] = await Array.fromAsync(new Bun.Glob("*-*").scan(starts));
    // The fake host's file is named <time>-<pid>.
    process.kill(Number(name?.split("-")[1]), "SIGKILL");
    await until(async () => {
      const state = (await (await ask(env, "/service")).json()) as {
        crashed: boolean;
      };
      return state.crashed;
    });
  });

  it("runs the host's own upgrade as its child, with what the host passed and how to find the app", async () => {
    const { env, program } = await setUp();
    const out = join(dir, "job.json");
    const answer = await ask(env, "/worker/start", {
      name: "io.eta.host-upgrade",
      argv: [program, "upgrade", "--worker", "abc", "--target", program],
      env: { PASSED: "yes", JOB_OUT: out },
    });
    expect(answer.status).toBe(200);
    await until(() => Bun.file(out).exists());
    const job = JSON.parse(await readFile(out, "utf8")) as Record<
      string,
      unknown
    >;
    expect(job).toEqual({
      argv: ["upgrade", "--worker", "abc", "--target", program],
      passed: "yes",
      service: env[SERVICE_ENV],
    });
    expect(server?.busy()).toBe(true);

    await ask(env, "/worker/stop", { name: "io.eta.host-upgrade" });
    await until(async () => server?.busy() === false);
  });

  it("runs nothing but that", async () => {
    const { env, program } = await setUp();
    for (const argv of [
      ["/bin/sh", "-c", "true"],
      [program, "install-service"],
    ]) {
      const answer = await ask(env, "/worker/start", {
        name: "io.eta.host-upgrade",
        argv,
        env: {},
      });
      expect(answer.status).toBe(403);
    }
    expect(server?.busy()).toBe(false);
  });
});
