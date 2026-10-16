import type { StorybookConfig } from "@storybook/react-vite";

const config = {
  stories: ["../src/**/*.stories.tsx"],
  framework: "@storybook/react-vite",
  async viteFinal(config) {
    config.server = { ...config.server, port: 6006, strictPort: false };
    return config;
  },
} satisfies StorybookConfig;

export default config;
