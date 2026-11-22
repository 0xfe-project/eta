import { blobatar } from "blobatar";
import { Image } from "nsh";
import { agentById } from "../app/lists";

/**
 * The agent's face, drawn from its avatar seed as on the web, or from its id when it never drew
 * one, so a rename keeps it.
 */
export function AgentAvatar(props: { id: string; size?: number }) {
  const size = () => props.size ?? 20;
  const uri = () =>
    `data:image/svg+xml;utf8,${encodeURIComponent(String(blobatar(agentById(props.id)?.avatarSeed ?? props.id)))}`;
  return (
    <Image
      src={uri()}
      style={{ width: size(), height: size(), flexShrink: 0 }}
    />
  );
}
