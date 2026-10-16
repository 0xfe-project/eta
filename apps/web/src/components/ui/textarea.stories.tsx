import type { Meta, StoryObj } from "@storybook/react-vite";
import { Textarea } from "./textarea";

const meta = {
  title: "控件/Textarea",
  component: Textarea,
  args: { "aria-label": "说明", className: "max-w-sm" },
} satisfies Meta<typeof Textarea>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = { name: "空", args: { placeholder: "说明" } };
export const Filled: Story = {
  name: "已填写",
  args: { defaultValue: "把这段话留给人读。" },
};
export const Invalid: Story = {
  name: "无效",
  args: { defaultValue: "把这段话留给人读。", "aria-invalid": true },
};
export const Disabled: Story = {
  name: "不可用",
  args: { defaultValue: "把这段话留给人读。", disabled: true },
};
