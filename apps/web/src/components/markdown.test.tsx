import { describe, expect, it } from "@rstest/core";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./markdown";

function render(source: string, streaming = false) {
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(
    <Markdown streaming={streaming}>{source}</Markdown>,
  );
  return root;
}

function hrefs(source: string) {
  return [...render(source).querySelectorAll("a")].map((a) =>
    a.getAttribute("href"),
  );
}

describe("Markdown links next to Chinese text", () => {
  it.each([
    ["见 https://example.com/a，然后继续。", "https://example.com/a"],
    ["见 https://example.com/a。", "https://example.com/a"],
    ["（https://example.com/a）中文", "https://example.com/a"],
    [
      "PR：https://github.com/a/b/pull/1」完成",
      "https://github.com/a/b/pull/1",
    ],
    ["见 https://example.com/a 说明文字", "https://example.com/a"],
    [
      "see https://example.com/path?q=1#frag.",
      "https://example.com/path?q=1#frag",
    ],
  ])("%s", (source, href) => {
    const root = render(source);
    expect(hrefs(source)).toEqual([href]);
    expect(root.textContent).toBe(source);
  });

  it("keeps Chinese paths and splits joined URLs", () => {
    expect(hrefs("https://zh.wikipedia.org/wiki/中文，后面")).toEqual([
      encodeURI("https://zh.wikipedia.org/wiki/中文"),
    ]);
    expect(hrefs("https://a.com/x，https://b.com/y。")).toEqual([
      "https://a.com/x",
      "https://b.com/y",
    ]);
  });

  it("keeps explicit link destination and text", () => {
    const a = render("[链接](https://example.com/a)后面中文").querySelector(
      "a",
    )!;
    expect(a.getAttribute("href")).toBe("https://example.com/a");
    expect(a.textContent).toBe("链接");
  });

  // Known limits: no full-width punctuation or space means no boundary.
  it("still links Chinese text with no boundary", () => {
    expect(hrefs("见 https://example.com/a说明文字")).toEqual([
      encodeURI("https://example.com/a说明文字"),
    ]);
  });

  it("supports emphasis and strikethrough next to Chinese", () => {
    const root = render("**加粗：**中文 ~~删除：~~中文");
    expect(root.querySelector("strong")!.textContent).toBe("加粗：");
    expect(root.querySelector("del")!.textContent).toBe("删除：");
  });

  it("leaves code and images alone", () => {
    const root = render(
      "`https://example.com/a，中文`\n\n```\nhttps://example.com/b，中文\n```\n\n![图](https://example.com/c.png)说明",
    );
    expect(root.querySelectorAll("a")).toHaveLength(0);
    expect(root.querySelector("p code")!.textContent).toBe(
      "https://example.com/a，中文",
    );
    expect(root.querySelector("pre code")!.textContent).toBe(
      "https://example.com/b，中文\n",
    );
    expect(root.querySelector("img")!.getAttribute("src")).toBe(
      "https://example.com/c.png",
    );
  });

  it("drops raw HTML and unsafe links", () => {
    const root = render("[坏](javascript:alert(1)) <b>x</b>");
    expect(root.querySelector("a")!.hasAttribute("href")).toBe(false);
    expect(root.querySelector("b")).toBeNull();
  });
});

describe("Markdown", () => {
  it("opens links in a new tab without an opener", () => {
    for (const a of render(
      "[a](https://a.com) 和 https://b.com/x，中文",
    ).querySelectorAll("a")) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });

  it("renders plain tables and code blocks, styled by .markdown", () => {
    const root = render("| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nx\n```");
    expect(root.firstElementChild!.classList).toContain("markdown");
    expect(root.querySelectorAll("table td")).toHaveLength(2);
    expect(root.querySelector("pre > code")!.textContent).toBe("x\n");
    // No toolbars or Streamdown classes of its own, only a copy button.
    expect(root.querySelectorAll("button")).toHaveLength(1);
    expect(root.querySelector("pre + button")!.getAttribute("aria-label")).toBe(
      "复制",
    );
    expect(
      root.querySelector("[class*=streamdown], [data-streamdown]"),
    ).toBeNull();
  });

  it("renders the same finished text in either mode", () => {
    const source =
      "# 标题\n\n见 https://example.com/a，然后\n\n**加粗**中文\n\n- x\n- y";
    // Streaming renders block by block, without newlines between them.
    const html = (root: HTMLElement) => root.innerHTML.replaceAll(">\n<", "><");
    expect(html(render(source, true))).toBe(html(render(source)));
    expect(render(source, true).querySelector("strong")!.textContent).toBe(
      "加粗",
    );
  });

  it("does not animate text or list markers being streamed", () => {
    const root = render("# 标题\n\n**加粗**中文\n\n- x\n- y", true);
    expect(root.querySelector("li")!.textContent).toBe("x");
    expect(root.innerHTML).not.toContain("data-sd-animate");
  });

  it("closes unfinished bold and code while they are streamed", () => {
    expect(
      render("前面 **加粗", true).querySelector("strong")!.textContent,
    ).toBe("加粗");
    expect(
      render("```ts\nconst a = 1", true).querySelector("pre > code")!
        .textContent,
    ).toBe("const a = 1\n");
  });

  it("gives a link still being streamed no destination", () => {
    const a = render("见 [链接](https://exa", true).querySelector("a")!;
    expect(a.textContent).toBe("链接");
    expect(a.hasAttribute("href")).toBe(false);
  });
});
