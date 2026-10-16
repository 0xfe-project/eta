import type { Meta, StoryObj } from "@storybook/react-vite";
import { Input } from "./input";

const meta = {
  title: "控件/Input",
  component: Input,
  args: { "aria-label": "名称", className: "max-w-xs" },
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = { name: "空", args: { placeholder: "名称" } };
export const Filled: Story = {
  name: "已填写",
  args: { defaultValue: "Moshi" },
};
export const Invalid: Story = {
  name: "无效",
  args: { defaultValue: "Moshi", "aria-invalid": true },
};
export const Disabled: Story = {
  name: "不可用",
  args: { defaultValue: "Moshi", disabled: true },
};
