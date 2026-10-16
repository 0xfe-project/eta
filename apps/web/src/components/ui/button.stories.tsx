import type { Meta, StoryObj } from "@storybook/react-vite";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { Button } from "./button";

const meta = {
  title: "控件/Button",
  component: Button,
  args: { children: "按钮" },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { name: "默认" };
export const Secondary: Story = {
  name: "次要",
  args: { variant: "secondary" },
};
export const Outline: Story = { name: "描边", args: { variant: "outline" } };
export const Ghost: Story = { name: "幽灵", args: { variant: "ghost" } };
export const Destructive: Story = {
  name: "删除",
  args: { variant: "destructive" },
};
export const Link: Story = { name: "链接", args: { variant: "link" } };
export const Disabled: Story = { name: "不可用", args: { disabled: true } };
export const ExtraSmall: Story = { name: "极小", args: { size: "xs" } };
export const Small: Story = { name: "小", args: { size: "sm" } };
export const Large: Story = { name: "大", args: { size: "lg" } };
export const Icon: Story = {
  name: "图标",
  args: { size: "icon", "aria-label": "新建", children: <PlusIcon /> },
};
