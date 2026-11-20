import { blobatar } from "blobatar";
import { computed, Image } from "nsh";

export function AgentFace(props: { id?: string | null; size?: number }) {
  const size = () => props.size ?? 20;
  // Seed by ID as in the legacy clients so renames preserve an agent's face.
  // Blobatar draws inside the middle of a 100x100 box; crop to the blob so the
  // face fills the avatar like the design's solid circle.
  const src = computed(
    () =>
      `data:image/svg+xml;utf8,${encodeURIComponent(
        blobatar(props.id ?? "agent").replace(
          'viewBox="0 0 100 100"',
          'viewBox="16 16 68 68"',
        ),
      )}`,
  );
  return (
    <Image
      src={src()}
      fadeDuration={0}
      style={{ width: size(), height: size(), flexShrink: 0 }}
    />
  );
}
