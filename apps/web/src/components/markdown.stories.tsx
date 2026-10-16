import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ComponentProps } from "react";
import { useEffect, useState } from "react";
import { Markdown } from "./markdown";

const meta = {
  title: "正文/Markdown",
  component: Markdown,
} satisfies Meta<typeof Markdown>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Paragraph: Story = {
  name: "段落",
  args: {
    children: "把这段话留给人读。\n\n- 第一点\n- 第二点",
    className: "max-w-content",
  },
};

export const Code: Story = {
  name: "代码",
  args: {
    children: "安装之后在这个目录看组件。\n\n```bash\nbun run storybook\n```",
    className: "max-w-content",
  },
};

const written = `这段文字是一个字一个字出现的，每个字都从模糊里淡出来。

- 列表项也一样
- 标题和加粗**也是**

\`\`\`bash
bun run storybook
\`\`\`

不写字的时候没有动效：模糊只给新出现的字符。`;

// `streaming` is the only switch. The blur is per character and only applies to
// characters added since the last render, so a fixed string plays it once and
// then sits still. Typing the text out keeps new characters arriving; toggling
// `streaming` off and on replays the whole run.
function Typing({ children, ...props }: ComponentProps<typeof Markdown>) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let shown = 0;
    const id = setInterval(() => {
      shown = Math.min(shown + 1, children.length);
      setCount(shown);
      if (shown >= children.length) clearInterval(id);
    }, 45);
    return () => clearInterval(id);
  }, [children]);
  return <Markdown {...props}>{children.slice(0, count)}</Markdown>;
}

export const Streaming: Story = {
  name: "流式",
  args: { children: written, className: "max-w-content", streaming: true },
  render: (args) => <Typing {...args} />,
};
