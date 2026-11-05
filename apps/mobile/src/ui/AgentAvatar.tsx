import { blobatar } from "blobatar";
import { Image } from "nsh";

/** The agent's face, generated from its id as on the web, so a rename keeps it. */
export function AgentAvatar(props: { id: string; size?: number }) {
  const size = () => props.size ?? 20;
  const uri = () =>
    `data:image/svg+xml;utf8,${encodeURIComponent(String(blobatar(props.id)))}`;
  return (
    <Image
      src={uri()}
      style={{ width: size(), height: size(), flexShrink: 0 }}
    />
  );
}
