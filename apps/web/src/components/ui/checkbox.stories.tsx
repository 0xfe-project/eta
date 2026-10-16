import type { Meta, StoryObj } from "@storybook/react-vite";
import { Checkbox } from "./checkbox";

const meta = {
  title: "控件/Checkbox",
  component: Checkbox,
  args: { "aria-label": "记住" },
} satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Unchecked: Story = { name: "未选" };
export const Checked: Story = { name: "已选", args: { defaultChecked: true } };
export const Invalid: Story = {
  name: "无效",
  args: { "aria-invalid": true },
};
export const Disabled: Story = { name: "不可用", args: { disabled: true } };
