import type { Meta, StoryObj } from "@storybook/react-vite";
import { Select, SelectGroup, SelectOption } from "./select-field";

const meta = {
  title: "控件/SelectField",
  component: Select,
  // `Select` requires children; the stories below render their own tree.
  args: { children: null },
} satisfies Meta<typeof Select>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  name: "未选",
  render: () => (
    <div className="max-w-xs">
      <Select aria-label="模型">
        <SelectGroup label="模型">
          <SelectOption value="fast">快</SelectOption>
          <SelectOption value="careful">仔细</SelectOption>
        </SelectGroup>
      </Select>
    </div>
  ),
};

export const Filled: Story = {
  name: "已选",
  render: () => (
    <div className="max-w-xs">
      <Select aria-label="模型" defaultValue="fast">
        <SelectGroup label="模型">
          <SelectOption value="fast">快</SelectOption>
          <SelectOption value="careful">仔细</SelectOption>
        </SelectGroup>
      </Select>
    </div>
  ),
};

export const Invalid: Story = {
  name: "无效",
  render: () => (
    <div className="max-w-xs">
      <Select aria-label="模型" aria-invalid>
        <SelectGroup label="模型">
          <SelectOption value="fast">快</SelectOption>
        </SelectGroup>
      </Select>
    </div>
  ),
};
