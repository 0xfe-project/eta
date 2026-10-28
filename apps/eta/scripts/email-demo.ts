import type { AgentView, EmailAccountView } from "@eta/client-contracts";
import type { KernelModels } from "@eta/core";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import imapkit from "imapkit";
import { startHost } from "../src/host";
import { connect } from "../test/support/client";
import { call, say, scriptedModels } from "../test/support/models";

const root = resolve(import.meta.dir, "../../..");
const webDir = resolve(root, "apps/web/dist");
if (!existsSync(join(webDir, "index.html"))) {
  throw new Error(
    "The web build is missing. Run `bun run --cwd apps/web build` first.",
  );
}

const dataRoot =
  process.env.ETA_EMAIL_DEMO_DATA ??
  mkdtempSync(join(tmpdir(), "eta-email-demo-"));
const A_IMAP = 21143;
const A_SMTP = 21025;
const A_WEB = 19001;
const B_IMAP = 22143;
const B_SMTP = 22025;
const B_WEB = 19002;
const PASSWORD = "eta-demo-password";

function mailbox(email: string, smtpPort: number) {
  return imapkit({
    users: { [email]: { password: PASSWORD } },
    storage: {
      INBOX: { subscribed: true, messages: [] },
      "": { folders: { Junk: { subscribed: true, messages: [] } } },
    },
    plugins: ["SPECIAL-USE"],
    smtp: { host: "127.0.0.1", port: smtpPort },
  });
}

const aliceMail = mailbox("alice@eta.local", A_SMTP);
const bobMail = mailbox("bob@eta.local", B_SMTP);
await aliceMail.start(A_IMAP, "127.0.0.1");
await bobMail.start(B_IMAP, "127.0.0.1");
aliceMail.control.setSpecialUse("Junk", ["\\Junk"]);
bobMail.control.setSpecialUse("Junk", ["\\Junk"]);

const aliceModels = scriptedModels((request) => {
  if (request.lastRole === "toolResult")
    return say("The email is ready in the confirmation widget.");
  if (request.last?.includes("The user explicitly handed this email to you")) {
    const subject =
      request.last
        .split("\n")
        .find((line) => line.startsWith("## Email:"))
        ?.slice("## Email:".length)
        .trim() || "the email you assigned";
    return say(
      `I reviewed “${subject}”. The email context is ready; I can prepare a reply when you ask me to.`,
    );
  }
  return call(
    "send_email",
    {
      to: "bob@eta.local",
      subject: "Hello from Alice",
      markdown:
        "你好 Bob，\n\n这是一封由 **Alice Agent** 创建的 ETA 邮件。\n\n请在邮箱页手动交给你的 Agent，然后确认回复。",
      context: {
        from: "alice",
        purpose: "two-instance-mail-demo",
        steps: ["send", "handoff", "reply"],
      },
    },
    "email-send",
  );
});

const bobModels = scriptedModels((request) => {
  if (request.lastRole === "toolResult")
    return say("The reply is ready in the confirmation widget.");
  const threadId = /Thread:\s*([0-9a-f-]{36})/i.exec(request.last)?.[1];
  if (threadId !== undefined)
    return call(
      "reply",
      {
        threadId,
        markdown:
          "你好 Alice，\n\n**Bob Agent** 已收到并读完这封邮件。\n\n这是一条经过人工确认后发出的回复。",
        context: { from: "bob", handled: true },
      },
      "email-reply",
    );
  return say("Open the Email page, select the mail and hand it to me.");
});

const alice = await startHost({
  dataDir: join(dataRoot, "alice"),
  home: join(dataRoot, "home-alice"),
  port: A_WEB,
  hostname: "127.0.0.1",
  webDir,
  llm: false,
  github: false,
  models: aliceModels.models as KernelModels as never,
});
const bob = await startHost({
  dataDir: join(dataRoot, "bob"),
  home: join(dataRoot, "home-bob"),
  port: B_WEB,
  hostname: "127.0.0.1",
  webDir,
  llm: false,
  github: false,
  models: bobModels.models as KernelModels as never,
});

async function setup(
  port: number,
  agentName: string,
  address: string,
  smtpPort: number,
  imapPort: number,
): Promise<{ agent: AgentView; account: EmailAccountView }> {
  const client = await connect(`ws://127.0.0.1:${port}/ws`);
  await client.hello();
  const agents = client.section<AgentView[]>("agents", "list") ?? [];
  let agent = agents.find((candidate) => candidate.name === agentName);
  if (!agent) {
    ({ agent } = (await client.call("agents", "create", {
      name: agentName,
    })) as { agent: AgentView });
  }
  const accounts =
    client.section<EmailAccountView[]>("email", "accounts") ?? [];
  let account = accounts.find(
    (candidate) => candidate.address === address.toLowerCase(),
  );
  if (!account) {
    ({ account } = (await client.call("email", "saveAccount", {
      name: address,
      address,
      smtpHost: "127.0.0.1",
      smtpPort,
      smtpSecure: false,
      imapHost: "127.0.0.1",
      imapPort,
      imapSecure: false,
      inboxFolder: "INBOX",
      username: address,
      password: PASSWORD,
      pollIntervalSeconds: 60,
    })) as { account: EmailAccountView });
  } else if (account.status !== "ready") {
    ({ account } = (await client.call("email", "verifyAccount", {
      accountId: account.id,
    })) as { account: EmailAccountView });
  }
  await client.call("email", "refresh", { accountId: account.id });
  client.close();
  if (account.status !== "ready") {
    throw new Error(
      `${address}: ${account.lastError ?? "verification failed"}`,
    );
  }
  return { agent, account };
}

await setup(A_WEB, "Alice Agent", "alice@eta.local", B_SMTP, A_IMAP);
await setup(B_WEB, "Bob Agent", "bob@eta.local", A_SMTP, B_IMAP);

console.log(`
ETA dual-instance email test is ready.

Alice: http://127.0.0.1:${A_WEB}
Bob:   http://127.0.0.1:${B_WEB}

1. Open Alice, start a private chat with Alice Agent, and ask it to send an email.
2. Confirm the email widget in Alice's chat.
3. Open Bob's Email page, select the message, and hand it to Bob Agent.
4. Confirm the reply widget in Bob's session log.
5. Alice's Email page receives the reply.

Local mail: Alice SMTP/IMAP ${A_SMTP}/${A_IMAP}, Bob ${B_SMTP}/${B_IMAP}
Data: ${dataRoot}
`);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await Promise.allSettled([alice.close(), bob.close()]);
  await Promise.allSettled([aliceMail.stop(), bobMail.stop()]);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
await new Promise(() => undefined);
