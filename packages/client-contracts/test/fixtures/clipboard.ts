// Clipboards as the editor receives them (`text`, `html`, `files`, `uris`). The web page and the
// table were recorded from Chromium (Playwright's build) (select, Ctrl+C, `navigator.clipboard.read()`); the others
// are each platform's flavours for that copy, written out by hand from what the platform puts there.
import type { ClipboardInput } from "../../src/composer-doc";

export const samples = {
  /** VS Code: three lines of code; HTML of coloured spans; a whole line copied ends in "\n". */
  vscode: {
    text: "function add(a, b) {\n  return a + b;\n}\n",
    html: '<meta charset="utf-8"><div style="color: #d4d4d4;background-color: #1e1e1e;font-family: Menlo, Monaco, monospace;font-size: 12px;line-height: 18px;white-space: pre;"><div><span style="color: #569cd6;">function</span><span style="color: #d4d4d4;"> </span><span style="color: #dcdcaa;">add</span>(a, b) {</div><div>  <span style="color: #c586c0;">return</span> a + b;</div><div>}</div></div>',
  },
  /** VS Code: one line copied with no selection (the whole line and its newline). */
  vscodeLine: { text: "const answer = 42;\n" },
  /** A web page's paragraphs and list (Chromium). */
  webPage: {
    text: "Release notes\nThe composer now folds long pastes.\n\nInline files\nMentions",
    html: '<h2 style="color: rgb(0, 0, 0); font-family: &quot;Times New Roman&quot;; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;">Release notes</h2><p style="color: rgb(0, 0, 0); font-family: &quot;Times New Roman&quot;; font-size: medium; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;">The <b>composer</b> now folds <a href="https://example.com/x">long pastes</a>.</p><ul style="color: rgb(0, 0, 0); font-family: &quot;Times New Roman&quot;; font-size: medium; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; font-weight: 400; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; white-space: normal; text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;"><li>Inline files</li><li>Mentions</li></ul>',
  },
  /** A table on a web page (Chromium): tab-separated text. */
  webTable: {
    text: "\nName\tSize\nshot.png\t2 KB\nnotes.txt\t12 B\n",
    html: '<table id="t" style="font-family: &quot;Times New Roman&quot;; letter-spacing: normal; orphans: 2; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px; text-decoration-thickness: initial; text-decoration-style: initial; text-decoration-color: initial;"><tbody><tr><th>Name</th><th>Size</th></tr><tr><td>shot.png</td><td>2 KB</td></tr><tr><td>notes.txt</td><td>12 B</td></tr></tbody></table>',
  },
  /** Finder: a copied file is its name as text, its URL, and its icon as a picture. */
  finder: {
    text: "notes.txt",
    files: [{ name: "notes.tiff", type: "image/tiff" }],
    uris: ["file:///Users/me/Desktop/notes.txt"],
  },
  /** A screenshot to the clipboard (macOS ⌃⇧⌘4, Windows Snipping Tool): an image alone. */
  screenshot: { files: [{ name: "image.png", type: "image/png" }] },
  /** Excel / Numbers cells: tab-separated text, HTML and a picture of the cells. */
  spreadsheet: {
    text: "Quarter\tRevenue\r\nQ1\t1200\r\nQ2\t1350\r\nQ3\t1500\r\nQ4\t1720\r\n",
    html: '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><body><table><tr><td>Quarter</td><td>Revenue</td></tr><tr><td>Q1</td><td>1200</td></tr></table></body></html>',
    files: [{ name: "image.png", type: "image/png" }],
  },
  /** A terminal's selection: plain text, its last line ending in a newline. */
  terminal: {
    text: "$ ls -la\ntotal 8\ndrwxr-xr-x 2 me me 4096 Nov 21 .\n-rw-r--r-- 1 me me   12 Nov 21 notes.txt\n",
  },
  /** Word on Windows: CRLF text, Office HTML and a picture (EMF/PNG) of the copied paragraph. */
  word: {
    text: "Dear team,\r\n\r\nThe draft is attached.\r\n",
    html: '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><body><p class=MsoNormal>Dear team,<o:p></o:p></p><p class=MsoNormal><o:p>&nbsp;</o:p></p><p class=MsoNormal>The draft is <b>attached</b>.<o:p></o:p></p></body></html>',
    files: [{ name: "image.png", type: "image/png" }],
  },
  /** Plain text with Windows newlines (Notepad). */
  windowsNewlines: { text: "one\r\ntwo\r\nthree\r\nfour\r\nfive" },
  /** A PDF and a picture copied together in a file manager. */
  twoFiles: {
    files: [
      { name: "report.pdf", type: "application/pdf" },
      { name: "chart.png", type: "image/png" },
    ],
  },
} satisfies Record<string, ClipboardInput>;
