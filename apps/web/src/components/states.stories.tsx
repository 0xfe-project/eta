import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChatsCircleIcon } from "@phosphor-icons/react/ChatsCircle";
import { Button } from "@/components/ui/button";
import { Empty, LoadError, Loading } from "./states";

const meta = { title: "状态" } satisfies Meta;
export default meta;

export const LoadingList: StoryObj = {
  name: "加载 · 列表",
  render: () => <Loading layout="list" />,
};

export const LoadingDetail: StoryObj = {
  name: "加载 · 详情",
  render: () => <Loading layout="detail" />,
};

export const LoadingLines: StoryObj = {
  name: "加载 · 几行",
  render: () => <Loading layout="lines" rows={2} />,
};

export const EmptyState: StoryObj = {
  name: "空",
  render: () => (
    <Empty
      icon={ChatsCircleIcon}
      title="还没有对话"
      action={<Button size="sm">新建</Button>}
    >
      选一个 Agent，从这里开始。
    </Empty>
  ),
};

export const ErrorState: StoryObj = {
  name: "加载失败",
  render: () => (
    <LoadError what="对话" error={new Error("连接中断")} onRetry={() => {}} />
  ),
};
