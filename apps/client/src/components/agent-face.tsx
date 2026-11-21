import { blobatar } from "blobatar";
import { computed, Image, View } from "nsh";

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

/**
 * The user's own face ("Me"): the design's grey disc with two dark eyes, the
 * same in both themes. The routine report's feedback thread draws it.
 * @public
 */
export function UserFace(props: { size?: number }) {
  const size = () => props.size ?? 20;
  const eye = (left: number) => ({
    position: "absolute" as const,
    left: size() * left,
    top: size() * 0.4,
    width: Math.max(1, Math.round(size() * 0.12)),
    height: Math.max(1, Math.round(size() * 0.2)),
    backgroundColor: "#2b2b2b",
  });
  return (
    <View
      accessibilityElementsHidden
      style={{
        width: size(),
        height: size(),
        borderRadius: size() / 2,
        backgroundColor: "#b8b8b8",
        flexShrink: 0,
      }}
    >
      <View style={eye(0.3)} />
      <View style={eye(0.58)} />
    </View>
  );
}
