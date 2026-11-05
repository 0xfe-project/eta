import { Header, Page } from "../../ui/Page";

export function GroupInfoScreen(_props: { id: string }) {
  return <Page><Header title="GroupInfoScreen" /></Page>;
}

export function AgentInfoScreen(_props: { id: string }) {
  return <Page><Header title="AgentInfoScreen" /></Page>;
}

export function ArtifactScreen(_props: { id: string; version?: number | undefined }) {
  return <Page><Header title="ArtifactScreen" /></Page>;
}

