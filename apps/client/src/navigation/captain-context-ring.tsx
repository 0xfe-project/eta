import type {
  AgentMessage,
  CaptainIdentityView,
  LlmModel,
  ProvidersView,
  SessionViewSections,
} from "@eta/client-contracts";
import { computed, Image } from "nsh";
import { colors, fill } from "../components";
import { follow, useHost } from "../services/host";

function messageLength(message: AgentMessage) {
  if ("summary" in message && typeof message.summary === "string")
    return message.summary.length;
  if (!("content" in message)) return 0;
  if (typeof message.content === "string") return message.content.length;
  return message.content.reduce((length, block) => {
    if (block.type === "text") return length + block.text.length;
    if (block.type === "thinking") return length + block.thinking.length;
    if (block.type === "toolCall")
      return length + JSON.stringify(block.arguments).length;
    return length;
  }, 0);
}

export function CaptainContextRing() {
  const host = useHost();
  const color = colors();
  const session = () => {
    const captain = host.section<CaptainIdentityView>("captain", "identity");
    const id = host
      .conversations()
      .find((group) => group.id === captain?.conversationId)
      ?.participants.find(
        (member) => member.agentId === captain?.agentId,
      )?.sessionId;
    return id ? `sessions.${id}` : undefined;
  };
  follow(session);

  const source = computed(() => {
    const target = session();
    const c = color();
    const circle =
      '<circle cx="22" cy="22" r="20.5" fill="none" stroke-width="3"';
    let segments = "";
    if (target) {
      const section = <K extends keyof SessionViewSections & string>(name: K) =>
        host.section<SessionViewSections[K]>(target, name);
      const prompt = section("prompt");
      const messages = section("transcript")?.messages ?? [];
      const compacted = messages.findLastIndex(
        ({ message }) => message.role === "compactionSummary",
      );
      let user = 0;
      let assistant = 0;
      let tool = 0;
      for (const { message } of messages.slice(Math.max(0, compacted))) {
        const length = messageLength(message);
        if (message.role === "user") user += length;
        else if (message.role === "toolResult") tool += length;
        else assistant += length;
      }
      const toolDefs = (section("tools") ?? []).reduce(
        (length, { name, description }) =>
          length + name.length + description.length,
        0,
      );
      const stable = prompt?.stableChars ?? 0;
      const slices = [
        [stable, c.faint, 1],
        [Math.max(0, (prompt?.adaptiveChars ?? 0) - stable), c.muted, 1],
        [user, c.green, 1],
        [assistant, c.amber, 1],
        [toolDefs, c.blue, 0.45],
        [tool, c.blue, 1],
      ] as const;
      const model = section("model")?.id;
      const configured = host.section<ProvidersView>("providers", "config");
      const windowSize =
        host
          .list<LlmModel>("llm", "models")
          .find(({ id }) => `llm:${id}` === model)?.contextWindow ??
        configured?.providers
          .flatMap((provider) =>
            provider.models.map((entry) => ({
              id: `${provider.id}:${entry.id}`,
              window: entry.contextWindow,
            })),
          )
          .find(({ id }) => id === model)?.window ??
        128_000;
      const tokens = slices.map(([chars]) => Math.round(chars / 4));
      const capacity = Math.max(
        windowSize,
        tokens.reduce((a, b) => a + b, 0),
        1,
      );
      const circumference = 2 * Math.PI * 20.5;
      let offset = 0;
      segments = slices
        .map(([, stroke, opacity], index) => {
          const length = (tokens[index]! / capacity) * circumference;
          const dash = length - 0.75;
          const at = offset;
          offset += length;
          return dash > 0
            ? `${circle} stroke="${stroke}" stroke-opacity="${opacity}" stroke-dasharray="${dash} ${circumference - dash}" stroke-dashoffset="${-at}"/>`
            : "";
        })
        .join("");
    }
    return `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44">${circle} stroke="${c.ink}" stroke-opacity=".03"/><g transform="rotate(-90 22 22)">${segments}</g></svg>`,
    )}`;
  });

  return (
    <Image
      src={source()}
      fadeDuration={0}
      style={{ ...fill, width: 44, height: 44 }}
    />
  );
}
