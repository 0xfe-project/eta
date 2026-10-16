import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge } from "./badge";

const meta = {
  title: "控件/Badge",
  component: Badge,
  args: { children: "标签" },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { name: "默认" };
export const Secondary: Story = {
  name: "次要",
  args: { variant: "secondary" },
};
export const Outline: Story = { name: "描边", args: { variant: "outline" } };
export const Destructive: Story = {
  name: "危险",
  args: { variant: "destructive" },
};
export const Ghost: Story = { name: "幽灵", args: { variant: "ghost" } };
export const Link: Story = { name: "链接", args: { variant: "link" } };
