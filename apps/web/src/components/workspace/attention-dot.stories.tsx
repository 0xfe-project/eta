import type { Meta, StoryObj } from "@storybook/react-vite";
import { AttentionDot } from "./settings-nav";

const meta = {
  title: "设置/AttentionDot",
  component: AttentionDot,
} satisfies Meta<typeof AttentionDot>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { name: "默认" };
