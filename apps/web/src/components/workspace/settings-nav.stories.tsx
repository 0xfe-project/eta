import type { Meta, StoryObj } from "@storybook/react-vite";
import { PackageIcon } from "@phosphor-icons/react/Package";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { useState } from "react";
import { SettingsNav } from "./settings-nav";

const meta = {
  title: "设置/SettingsNav",
  component: SettingsNav,
} satisfies Meta<typeof SettingsNav>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Agents: Story = {
  name: "智能体",
  args: {
    label: "设置",
    value: "agents",
    onChange: () => {},
    sections: [
      { value: "agents", label: "智能体", icon: RobotIcon },
      { value: "bundles", label: "环境包", icon: PackageIcon },
    ],
  },
};

export const Attention: Story = {
  name: "有待处理",
  args: {
    label: "设置",
    value: "bundles",
    onChange: () => {},
    sections: [
      { value: "agents", label: "智能体", icon: RobotIcon },
      {
        value: "bundles",
        label: "环境包",
        icon: PackageIcon,
        attention: true,
        hint: "需要处理",
      },
    ],
  },
};

function SwitchingNav() {
  const [value, setValue] = useState("agents");
  return (
    <SettingsNav
      label="设置"
      value={value}
      onChange={setValue}
      sections={[
        { value: "agents", label: "智能体", icon: RobotIcon },
        { value: "bundles", label: "环境包", icon: PackageIcon },
      ]}
    />
  );
}

export const Switching: Story = {
  name: "可切换",
  args: {
    label: "设置",
    value: "agents",
    onChange: () => {},
    sections: [],
  },
  render: () => <SwitchingNav />,
};
