import type { Host } from "../src/host";
/**
 * Persona cards, from the file to the prompt (FRONTEND_REFACTOR.md §7, t96/t102).
 *
 * The wiring has three links, and each one can be broken without anything looking broken:
 *
 * 1. discovery — the cards that apply here are the harness's built-ins, `~/.eta/persona/`, and
 *    `<cwd>/.eta/persona/`, in that order of specificity;
 * 2. the list the interface shows — a picker is standing nowhere in particular, so it shows the
 *    union, and it has to contain the built-ins or an agent cannot be given one;
 * 3. the prompt — a card nobody loaded into the kernel is a name in a database column, so the
 *    session's own prompt sections are where "it is wired" is checked.
 *
 * The home directory is a temporary one here: the real `~/.eta/persona` belongs to whoever runs
 * the tests, and a test that read it would pass or fail depending on their files.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantMessage, fakeModels } from "@eta/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { assembleHost } from "../src/host";

const roots: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const CONFIG = {
  providers: [
    {
      id: "local",
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:1/v1",
      models: [{ id: "m1" }],
    },
  ],
  defaultModel: "local:m1",
};

interface Started {
  host: Host;
  home: string;
  project: string;
  groupId: string;
}

const call = async (
  host: Host,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> =>
  fetch(`http://127.0.0.1:${host.port}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });

async function start(): Promise<Started> {
  const root = await mkdtemp(join(tmpdir(), "eta-personas-"));
  roots.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  // One card everywhere, one card only in the project — the two places a person puts them.
  await mkdir(join(home, ".eta", "persona"), { recursive: true });
  await writeFile(
    join(home, ".eta", "persona", "GROK.persona.md"),
    "You are GROK. You answer in short sentences.\n",
    "utf8",
  );
  await mkdir(join(project, ".eta", "persona"), { recursive: true });
  await writeFile(
    join(project, ".eta", "persona", "critic.persona.md"),
    "You are the CRITIC. You find what is wrong before saying what is right.\n",
    "utf8",
  );
  const data = join(root, "data");
  await mkdir(data, { recursive: true });
  await writeFile(join(data, "config.json"), JSON.stringify(CONFIG), "utf8");
  const host = await assembleHost({
    dataDir: data,
    homeDir: home,
    port: 0,
    warn: () => undefined,
    models: fakeModels([
      assistantMessage({ content: [{ type: "text", text: "好" }] }),
    ]),
  });
  hosts.push(host);
  // The group is what says "this directory is a project of mine": the picker answers over the
  // projects that exist, so the card can only be listed once something points at it.
  const group = (await (
    await call(host, "POST", "/api/v1/groups", {
      name: "project group",
      cwd: project,
    })
  ).json()) as { id: string };
  return { host, home, project, groupId: group.id };
}

interface Card {
  id: string;
  name: string;
  description: string;
  custom: boolean;
}

const list = async (host: Host): Promise<Card[]> => {
  const response = await call(host, "GET", "/api/v1/personas");
  const body = (await response.json()) as {
    personas?: Card[];
    error?: unknown;
  };
  if (!response.ok) throw new Error(`personas: ${JSON.stringify(body)}`);
  return body.personas ?? [];
};

describe("persona cards", () => {
  it("lists the built-ins, the home directory's, and each project's", async () => {
    const { host } = await start();
    const cards = await list(host);
    const ids = cards.map((card) => card.id);

    // The built-ins are the floor of the namespace: without them a fresh machine offers nothing.
    expect(ids).toContain("Thinker");
    expect(ids).toContain("Executor");
    // Written by the person, in the two places they can write one.
    expect(ids).toContain("GROK");
    expect(ids).toContain("critic");

    const critic = cards.find((card) => card.id === "critic");
    expect(critic?.custom).toBe(true);
    // A card's own words are its summary, so the picker says what it does.
    expect(critic?.description).toContain("CRITIC");
  });

  it("puts the card an agent wears into that session's prompt", async () => {
    const { host, groupId } = await start();
    const agent = (await (
      await call(host, "POST", "/api/v1/agents", { name: "reviewer" })
    ).json()) as { id: string };
    await call(host, "PUT", `/api/v1/agents/${agent.id}/persona`, {
      persona: "critic",
    });
    // The agent has to be a member of the group for the store to wake it at all.
    await call(host, "PUT", `/api/v1/groups/${groupId}/members/${agent.id}`, {
      member: true,
    });

    await call(host, "POST", "/api/v1/chat/messages", {
      group_id: groupId,
      parts: [{ type: "text", text: "看一下这个 PR" }],
      mentions: [agent.id],
    });

    // The session the wake opened, and the prompt it would send.
    const snapshot = (await (
      await call(host, "GET", "/api/v1/chat")
    ).json()) as {
      groups: {
        id: string;
        participants: { agent_id: string; session_id: string | null }[];
      }[];
    };
    const sessionId = snapshot.groups
      .find((candidate) => candidate.id === groupId)
      ?.participants.find(
        (participant) => participant.agent_id === agent.id,
      )?.session_id;
    expect(sessionId).toBeTruthy();

    const prompt = (await (
      await call(host, "GET", `/sessions/${String(sessionId)}/prompt`)
    ).json()) as { sections: { name: string; text: string }[] };
    const said = prompt.sections.map((section) => section.text).join("\n");
    // The card's own sentence, in the *session's* prompt: the whole chain, end to end.
    expect(said).toContain("You are the CRITIC");
  });
});
