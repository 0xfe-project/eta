import type { Preview } from "@storybook/react-vite";
import { IconContext } from "@phosphor-icons/react/dist/lib/context";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Locale } from "./locale";
import "../src/styles.css";

const preview: Preview = {
  initialGlobals: {
    locale: "zh",
    theme: "light",
  },
  globalTypes: {
    locale: {
      name: "Language",
      toolbar: {
        icon: "globe",
        items: [
          { value: "zh", title: "中文" },
          { value: "en", title: "English" },
        ],
      },
    },
    theme: {
      name: "Theme",
      toolbar: {
        icon: "circlehollow",
        items: [
          { value: "light", title: "Light" },
          { value: "dark", title: "Dark" },
        ],
      },
    },
  },
  decorators: [
    (Story, ctx) => (
      <Locale locale={String(ctx.globals.locale)}>
        <ThemeProvider
          attribute="class"
          forcedTheme={String(ctx.globals.theme)}
          disableTransitionOnChange
        >
          <IconContext value={{ size: 20, weight: "regular" }}>
            <TooltipProvider>
              <div className="min-h-40 bg-background p-6 text-foreground">
                <Story />
              </div>
            </TooltipProvider>
          </IconContext>
        </ThemeProvider>
      </Locale>
    ),
  ],
};

export default preview;
