import { blobatar } from "blobatar";
import { computed, Image } from "nsh";

export function AgentFace(props: { id?: string | null; size?: number }) {
  const size = () => props.size ?? 20;
  // Seed by ID as in the legacy clients so renames preserve an agent's face.
  const src = computed(
    () =>
      `data:image/svg+xml;utf8,${encodeURIComponent(blobatar(props.id ?? "agent"))}`,
  );
  return (
    <Image
      src={src()}
      fadeDuration={0}
      style={{ width: size(), height: size(), flexShrink: 0 }}
    />
  );
}
