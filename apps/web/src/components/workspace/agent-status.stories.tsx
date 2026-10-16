import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentStatusDot } from "./agent-identity";

const meta = {
  title: "身份/AgentStatusDot",
  component: AgentStatusDot,
} satisfies Meta<typeof AgentStatusDot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = { name: "空闲", args: { status: "idle" } };
export const Starting: Story = { name: "启动中", args: { status: "starting" } };
export const Working: Story = { name: "工作中", args: { status: "working" } };
export const Waiting: Story = {
  name: "等待确认",
  args: { status: "waiting_for_input" },
};
export const Unavailable: Story = {
  name: "不可用",
  args: { status: "unavailable" },
};
