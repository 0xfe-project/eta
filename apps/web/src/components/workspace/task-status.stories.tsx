import type { Meta, StoryObj } from "@storybook/react-vite";
import { StatusIcon } from "./task-status-icon";

const meta = {
  title: "任务/StatusIcon",
  component: StatusIcon,
} satisfies Meta<typeof StatusIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Backlog: Story = { name: "待排", args: { status: "backlog" } };
export const Todo: Story = { name: "待办", args: { status: "todo" } };
export const InProgress: Story = {
  name: "进行中",
  args: { status: "in_progress" },
};
export const InReview: Story = { name: "复核", args: { status: "in_review" } };
export const Done: Story = { name: "完成", args: { status: "done" } };
export const Blocked: Story = { name: "阻塞", args: { status: "blocked" } };
export const Cancelled: Story = {
  name: "取消",
  args: { status: "cancelled" },
};
