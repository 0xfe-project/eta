import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentAvatar } from "./agent-identity";

const meta = {
  title: "身份/AgentAvatar",
  component: AgentAvatar,
  args: { agent: { id: "story-agent" }, className: "size-12" },
} satisfies Meta<typeof AgentAvatar>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Still: Story = { name: "静止" };
export const Animated: Story = { name: "动画", args: { animate: true } };
