import { describe, expect, it } from "@rstest/core";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./markdown";

function render(source: string) {
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(<Markdown>{source}</Markdown>);
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
    expect(root.querySelector("a")!.getAttribute("href")).toBe("");
    expect(root.querySelector("b")).toBeNull();
  });
});
