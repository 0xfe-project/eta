import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "./select";

const meta = { title: "控件/Select", component: Select } satisfies Meta<
  typeof Select
>;
export default meta;
type Story = StoryObj<typeof meta>;

function Choice({
  value,
  disabled,
  invalid,
  open,
}: {
  value?: string;
  disabled?: boolean;
  invalid?: boolean;
  open?: boolean;
}) {
  return (
    <Select defaultValue={value} disabled={disabled} defaultOpen={open}>
      <SelectTrigger aria-label="模型" aria-invalid={invalid} className="w-40">
        <SelectValue placeholder="选择模型" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>模型</SelectLabel>
          <SelectItem value="fast">快</SelectItem>
          <SelectItem value="careful">仔细</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export const Empty: Story = { name: "未选", render: () => <Choice /> };
export const Filled: Story = {
  name: "已选",
  render: () => <Choice value="fast" />,
};
export const Open: Story = { name: "展开", render: () => <Choice open /> };
export const Invalid: Story = {
  name: "无效",
  render: () => <Choice invalid />,
};
export const Disabled: Story = {
  name: "不可用",
  render: () => <Choice value="fast" disabled />,
};
