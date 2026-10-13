// The group-chat prototype for #111. index.html and workspace.html are
// snapshots of the real AXP web app (its DOM and compiled CSS, with sample
// data); this script turns them into the proposed design, reusing the app's
// own pieces: the tool-call rows and reference cards, the GitHub issue
// draft's dashed card, the slash menu, the task properties and sidebar rows.
// Nothing here talks to a server.

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const html = (markup) => {
  const t = document.createElement("template");
  t.innerHTML = markup.trim();
  return t.content.firstElementChild;
};
const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const params = new URLSearchParams(location.search);
const page = document.body.dataset.page;

// --- data ---------------------------------------------------------------------

const AGENTS = {
  Aria: { role: "产品与前端" },
  Bolt: { role: "后端与基础设施" },
  Cleo: { role: "审阅与测试" },
};
// Avatars: the sidebar's own blobatar images.
const sidebarSource = $("#tpl-sidebar-src")?.content ?? document;
for (const img of $$("aside img", sidebarSource)) {
  const name = img.closest("button")?.title?.replace(/^与 | 对话$/g, "");
  if (name && AGENTS[name]) AGENTS[name].avatar = img.getAttribute("src");
}
// Somebody else's work keeps Cleo busy, to show queueing across groups.
const busy = { Cleo: "g2" };

const TASK = { number: 112, title: "首页首屏：图标按需导入 + hero 图转 AVIF" };
const state = {
  group: params.get("g") || "g1",
  created: params.get("state") !== "draft",
  panel: params.get("panel") || "group",
  taskOpen: params.get("panel") === "task",
  exec: false,
  phone: params.get("phone") || "chat",
};

const groups = [
  {
    id: "g1",
    name: "首页首屏加载优化",
    members: ["Aria", "Bolt"],
    status: state.created ? "执行中" : "讨论中",
    target: [state.created ? "Bolt" : "Aria"],
    unread: 0,
    created: "今天 10:00",
    goal: "首页 LCP 从 3.1 s 降到 1.5 s 以内，不改视觉。",
    decided: ["只动打包与图片，不碰 SSR", "PR 附前后 Lighthouse 截图"],
    log: () => [
      ["system", "你创建了群「首页首屏加载优化」，邀请了 Aria、Bolt"],
      ["user", "@Aria @Bolt 首页太慢了，先看看瓶颈在哪？"],
      ["speaker", "Aria", "1/2"],
      [
        "tool",
        "运行命令",
        '/bin/bash -lc "bunx lighthouse http://web --only-categories=performance"',
      ],
      [
        "text",
        "首屏同步加载了整个图标库（约 380 KB），hero 图是 2.4 MB 的 PNG。换成按路径导入 + AVIF 能省一大半。",
      ],
      ["speaker", "Bolt", "2/2"],
      [
        "text",
        "服务端：/api/v1/chat 快照 p95 420 ms，主要是活跃回复的查询；它不在 LCP 的关键路径上，建议这次不动。",
      ],
      [
        "user",
        "同意，只动打包和图片。@Aria 整理成任务，交给我那台 Mac 上的 Claude 做。",
      ],
      ["speaker", "Aria"],
      [
        "tool",
        "tasks.draft_task",
        '{"title":"首页首屏：图标按需导入 + hero 图转 AVIF"}',
      ],
      state.created ? ["created"] : ["draft"],
      ...(state.created
        ? [
            ["system", "你创建了任务 #112，指派给 MacBook · Paseo · Claude"],
            ["card"],
            ["user", "@Bolt 看下 PR 有没有问题"],
            ["speaker", "Bolt"],
            ["tool", "tasks.get_task", '{"task":"112"}'],
            ["working"],
          ]
        : [
            [
              "text",
              "草稿在上面：目标、已定的和验收都从刚才的讨论里整理出来了，确认后我就创建。",
            ],
          ]),
    ],
  },
  {
    id: "g2",
    name: "周报自动化",
    members: ["Cleo"],
    status: "讨论中",
    target: ["Cleo"],
    unread: 2,
    created: "昨天 18:20",
    goal: "每周一 9:00 把上周合并的 PR 汇总成周报。",
    decided: ["用定时，不用远程电脑"],
    log: () => [
      ["system", "你创建了群「周报自动化」，邀请了 Cleo"],
      ["user", "上周的周报格式可以，就按这个来。"],
      [
        "tool",
        "routines.create_routine",
        '{"name":"每周 PR 周报","schedule":{"kind":"weekly","days":[1],"time":"09:00"}}',
      ],
      ["text", "已经做成每周一 9:00 的定时。我现在在补上周漏掉的两个仓库。"],
      ["working"],
    ],
  },
  {
    id: "g3",
    name: "Q4 发布说明",
    members: ["Aria", "Bolt", "Cleo"],
    status: "讨论中",
    target: ["Aria"],
    unread: 0,
    created: "10-11",
    goal: "整理本季度上线的功能，写成发布说明。",
    decided: [],
    log: () => [
      ["system", "你创建了群「Q4 发布说明」，邀请了 Aria、Bolt、Cleo"],
      ["user", "@Aria 先列个提纲"],
      ["speaker", "Aria"],
      [
        "text",
        "提纲：任务看板与远程电脑、Artifacts、环境包、长粘贴与附件。每节一段话加一张截图。",
      ],
    ],
  },
];
// Private chats: today's one-agent conversations, moved over unchanged.
const dms = Object.keys(AGENTS).map((name) => ({
  id: `dm-${name}`,
  name,
  members: [name],
  dm: true,
  status: "讨论中",
  target: [name],
  unread: 0,
  created: "10-08",
  goal: "",
  decided: [],
  log: () =>
    name === "Aria"
      ? "original"
      : [
          ["user", "在吗？"],
          ["text", "在，说吧。"],
        ],
}));
const all = () => [...groups, ...dms];
const current = () => all().find((g) => g.id === state.group) ?? groups[0];

// --- templates from the snapshot -------------------------------------------------

const log = $('[role="log"][aria-label="对话消息"]');
const originalLog = log?.innerHTML;
const tpl = {};
if (log) {
  tpl.user = log.firstElementChild.cloneNode(true);
  const details = $$("details", log);
  tpl.tool = details
    .find((d) => d.textContent.includes("tasks.get_task"))
    .cloneNode(true);
  const refs = $$('a[aria-label^="打开任务"]', log);
  tpl.taskWorking = refs[0].cloneNode(true);
  tpl.taskReview = refs[1].cloneNode(true);
  tpl.artifact = $('[aria-label^="打开 Artifact"]', log).cloneNode(true);
  tpl.text = $$(".markdown", log).at(-1).parentElement.cloneNode(true);
  tpl.draft = $("#tpl-draft").content.firstElementChild;
  tpl.working = $("#tpl-working").content.firstElementChild;
  tpl.slash = $("#tpl-slash").content.firstElementChild;
}

const avatar = (name, size = "size-4", extra = "") =>
  `<img alt="" aria-hidden="true" class="shrink-0 ${size}" src="${AGENTS[name].avatar}" style="${extra}">`;
const stack = (names, size = "size-5", overlap = 6) =>
  `<span class="flex shrink-0">${names.map((n, i) => avatar(n, size, i ? `margin-left:-${overlap}px` : "")).join("")}</span>`;
const mentions = (text) =>
  esc(text).replace(
    /@(Aria|Bolt|Cleo|所有人)/g,
    '<span style="color: var(--terminal-link)">@$1</span>',
  );
const mono =
  'style="font-family: var(--font-mono); font-size: 13px; line-height: 1.55"';

function userRow(text) {
  const row = tpl.user.cloneNode(true);
  $(".whitespace-pre-wrap", row).innerHTML = mentions(text);
  return row;
}
function textRow(text) {
  const row = tpl.text.cloneNode(true);
  $(".markdown", row).innerHTML =
    `<p>${esc(text).replace(/`([^`]+)`/g, "<code>$1</code>")}</p>`;
  return row;
}
function toolRow(name, input) {
  const row = tpl.tool.cloneNode(true);
  const spans = $$("summary span span span", row);
  spans[0].textContent = name;
  spans[2].textContent = input;
  return row;
}
// Who speaks: shown only where more than one agent can answer.
function speakerRow(name, note) {
  return html(
    `<div class="flex items-center gap-2 pt-1" ${mono}>${avatar(name, "size-4")}<span style="color: var(--terminal-foreground); font-weight: 600">${name}</span>${note ? `<span style="color: var(--terminal-muted)">回复 ${note}</span>` : ""}</div>`,
  );
}
function systemRow(text) {
  return html(
    `<div class="text-center" style="font-family: var(--font-mono); font-size: 12px; color: var(--terminal-muted)">── ${esc(text)} ──</div>`,
  );
}
function workingRow(name, elsewhere) {
  if (elsewhere) {
    return html(
      `<div ${mono} style="font-family: var(--font-mono); font-size: 13px; color: var(--terminal-muted)">⏸ 排队中 · ${name} 正在「${esc(elsewhere)}」里工作，前面还有 1 条</div>`,
    );
  }
  return tpl.working.cloneNode(true);
}
function taskRef(status = "review") {
  const ref = (
    status === "review" ? tpl.taskReview : tpl.taskWorking
  ).cloneNode(true);
  ref.removeAttribute("href");
  ref.addEventListener("click", (e) => {
    e.preventDefault();
    openTask();
  });
  ref.style.cursor = "pointer";
  return ref;
}
// The task draft: the issue draft's dashed card, with the brief under it.
function draftCard() {
  const card = tpl.draft.cloneNode(true);
  card.style.flexDirection = "column";
  const a = $("a", card);
  a.removeAttribute("href");
  a.removeAttribute("target");
  a.setAttribute("aria-label", `创建任务：${TASK.title}`);
  a.title = "";
  const spans = $$(":scope > span", a);
  spans[0].innerHTML = `<span class="text-[var(--terminal-foreground)]">${TASK.title}</span><span class="text-[var(--terminal-muted)]"> · 任务草稿</span>`;
  spans[1].textContent = "创建任务";
  a.lastElementChild.remove();
  a.style.cursor = "pointer";
  a.addEventListener("click", () => {
    state.created = true;
    current().status = "执行中";
    render();
    openGroupPanel();
  });
  card.append(
    html(`<div class="px-2 pb-2" style="padding-left: calc(0.5rem + 1rem + 0.5rem); color: var(--terminal-muted); font-size: 12px; line-height: 1.7">
    <div><span style="display:inline-block;width:5ch">目标</span><span style="color: var(--terminal-foreground)">LCP ≤ 1.5 s（Lighthouse 移动端），视觉不变</span></div>
    <div><span style="display:inline-block;width:5ch">已定</span><span style="color: var(--terminal-foreground)">只改打包与图片；不碰 SSR</span></div>
    <div><span style="display:inline-block;width:5ch">验收</span><span style="color: var(--terminal-foreground)">PR 附前后 Lighthouse 截图；bun run check 通过</span></div>
    <div><span style="display:inline-block;width:5ch">指派</span><span style="color: var(--terminal-foreground)">MacBook · Paseo · Claude · 新 worktree</span></div>
    <div><span style="display:inline-block;width:5ch">来源</span>本群第 2–8 条消息，创建时定稿为任务描述 · <span style="color: var(--terminal-link); cursor: pointer">修改</span></div>
  </div>`),
  );
  return card;
}
// The task in the group: one card that follows the task's timeline.
function taskCard() {
  const box = html(`<div class="space-y-1"></div>`);
  box.append(taskRef("review"));
  const line = (inner) =>
    html(
      `<div class="ml-[2ch] flex gap-2" style="color: var(--terminal-muted); font-family: var(--font-mono); font-size: 13px; line-height: 1.55"><span aria-hidden="true">⎿</span><span class="min-w-0">${inner}</span></div>`,
    );
  box.append(
    line(
      `MacBook · Paseo · Claude：<span style="color: var(--terminal-foreground)">完成：LCP 3.1 s → 1.3 s，PR 和对比截图已附。</span> · 2 条评论`,
    ),
  );
  box.append(
    line(
      `交付 <span style="color: var(--terminal-foreground)">首页首屏：图标按需导入 + AVIF</span>（PR #240）`,
    ),
  );
  const art = tpl.artifact.cloneNode(true);
  box.append(art);
  const actions = line(
    `<span data-a="accept" style="color: var(--terminal-link); cursor: pointer">验收通过</span> · <span data-a="exec" style="color: var(--terminal-link); cursor: pointer">回复执行者</span> · <span data-a="open" style="color: var(--terminal-link); cursor: pointer">在侧栏打开</span>`,
  );
  actions.addEventListener("click", (e) => {
    const a = e.target.dataset.a;
    if (a === "open") openTask();
    if (a === "exec") {
      state.exec = true;
      renderComposer();
      $('[aria-label="消息"]')?.focus();
    }
    if (a === "accept") {
      current().log = withExtra(current().log, [
        [
          "system",
          "你验收了 #112 · 群里的任务都完成了，要把群标为「已完成」吗？",
        ],
      ]);
      render();
    }
  });
  box.append(actions);
  return box;
}
const extra = {};
function withExtra(fn, rows) {
  const g = current();
  extra[g.id] = [...(extra[g.id] ?? []), ...rows];
  return fn;
}

// --- the conversation ------------------------------------------------------------

function renderLog() {
  if (!log) return;
  const g = current();
  const rows = g.log();
  if (rows === "original") {
    log.innerHTML = originalLog;
    return;
  }
  log.replaceChildren();
  const multi = g.members.length > 1;
  for (const row of [...rows, ...(extra[g.id] ?? [])]) {
    const [kind, a, b] = row;
    let node;
    if (kind === "system") node = systemRow(a);
    else if (kind === "user") node = userRow(a);
    else if (kind === "speaker") node = multi ? speakerRow(a, b) : null;
    else if (kind === "tool") node = toolRow(a, b);
    else if (kind === "text") node = textRow(a);
    else if (kind === "draft") node = draftCard();
    else if (kind === "created")
      node = html(
        `<div class="ml-[2ch]" style="color: var(--terminal-muted); font-family: var(--font-mono); font-size: 12px">草稿已创建为 #112（见下方卡片）</div>`,
      );
    else if (kind === "card") node = taskCard();
    else if (kind === "working") node = workingRow(a, b);
    else if (kind === "node") node = a;
    if (node) log.append(node);
  }
  const scroller = log.closest(".overflow-y-auto");
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
}

// The avatar atop the chat: the group's members, its name on the label.
function renderHero() {
  const trigger = $('button[aria-label^="正在与"]');
  if (!trigger) return;
  const g = current();
  const svg = trigger.querySelector(":scope > svg, :scope > .proto-hero");
  // Sized inline: the app's CSS only has the size classes it uses.
  const px = g.members.length > 2 ? 48 : g.members.length > 1 ? 56 : 64;
  const cluster = html(
    `<span class="proto-hero flex">${g.members.map((n, i) => avatar(n, "", `width:${px}px;height:${px}px;${i ? `margin-left:-${px / 4}px` : ""}`)).join("")}</span>`,
  );
  svg.replaceWith(cluster);
  $(".truncate", trigger).textContent = g.dm ? g.name : g.name;
  trigger.setAttribute(
    "aria-label",
    g.dm
      ? `正在与 ${g.name} 对话，切换`
      : `群「${g.name}」（${g.members.join("、")}），切换`,
  );
  // The welcome box under it says where you are.
  const lines = $$('fieldset div[style*="terminal-muted"] > div');
  if (lines.length >= 3) {
    lines[0].textContent = g.members.join(" · ");
    lines[1].textContent = g.dm ? "私聊" : "群";
    lines[2].textContent = g.dm ? "GPT-5.5" : g.name;
  }
}

// The hero's menu: groups first, then the agents (their private chats).
function toggleMenu() {
  const open = $(".proto-menu");
  if (open) return open.remove();
  const source = $("#tpl-menu").content.firstElementChild;
  const itemClass = $('[role="menuitem"]', source).className;
  const sepClass =
    $('[role="separator"]', source)?.className ?? "-mx-1 my-1 h-px bg-border";
  const menu = source.cloneNode(false);
  menu.classList.add("proto-menu");
  menu.style.cssText =
    "position:absolute;left:50%;transform:translateX(-50%);top:104px;z-index:60";
  const label = (t) =>
    `<div class="px-2 py-1.5 text-xs text-muted-foreground">${t}</div>`;
  const item = (g) =>
    `<div role="menuitem" class="${itemClass}" data-g="${g.id}">${stack(g.members, "size-5")}<span class="min-w-0 flex-1 truncate">${esc(g.name)}</span>${g.id === state.group ? "✓" : g.unread ? `<span class="tabular-nums text-muted-foreground">${g.unread}</span>` : ""}</div>`;
  menu.innerHTML = `${
    label("群") + groups.map(item).join("")
  }<div role="separator" class="${sepClass}"></div>${label("智能体")}${dms
    .map(item)
    .join(
      "",
    )}<div role="separator" class="${sepClass}"></div><div role="menuitem" class="${itemClass}" data-new="group">＋ 新建群</div><div role="menuitem" class="${itemClass}" data-new="agent">＋ 新建智能体</div>`;
  menu.addEventListener("click", (e) => {
    const it = e.target.closest("[role=menuitem]");
    if (!it) return;
    menu.remove();
    if (it.dataset.g) select(it.dataset.g);
    if (it.dataset.new === "group") newGroup();
  });
  $(
    'button[aria-label^="正在与"], button[aria-label^="群"]',
  ).parentElement.style.position = "relative";
  $(
    'button[aria-label^="正在与"], button[aria-label^="群"]',
  ).parentElement.append(menu);
}

// --- the composer: who it goes to, @ to choose ---------------------------------

function renderComposer() {
  const g = current();
  const input = $('[aria-label="消息"]');
  if (!input) return;
  const placeholder = input.parentElement.querySelector(
    '[aria-hidden="true"] > div',
  );
  const to = state.exec ? "#112 的执行者" : g.target.join("、");
  input.setAttribute("aria-placeholder", `发消息给 ${to}…`);
  if (placeholder)
    placeholder.textContent = state.exec
      ? "这条会作为 #112 的评论发给 MacBook · Paseo · Claude…"
      : `发消息给 ${to}…`;
  const status = input.closest("form").querySelector(".text-\\[12px\\]");
  const muted = (t) => `<span style="color: var(--terminal-muted)">${t}</span>`;
  let who;
  if (state.exec) {
    who = `<span style="color: var(--terminal-link)">→ #112 执行者</span>${muted("（会排一次远程运行） · ")}<span data-cancel style="color: var(--terminal-link); cursor: pointer">取消</span>`;
  } else if (g.members.length === 1) {
    who = `${muted(
      "发给 ",
    )}<span style="color: var(--terminal-link)">@${g.members[0]}</span>`;
  } else {
    who =
      muted("发给 ") +
      g.members
        .map(
          (n) =>
            `<span data-t="${n}" style="cursor:pointer;color: ${g.target.includes(n) ? "var(--terminal-link)" : "var(--terminal-muted)"}; ${g.target.includes(n) ? "" : "text-decoration: line-through"}">@${n}</span>`,
        )
        .join(" ") +
      muted("（@ 改）");
  }
  status.innerHTML = `${muted('<span aria-hidden="true">⏸ </span>手动模式')}${muted(" · ")}${who}${muted(" · ? 查看快捷键")}`;
  status.onclick = (e) => {
    if (e.target.dataset.cancel !== undefined) {
      state.exec = false;
      return renderComposer();
    }
    const n = e.target.dataset.t;
    if (!n) return;
    g.target = g.target.includes(n)
      ? g.target.filter((x) => x !== n)
      : [...g.target, n];
    if (!g.target.length) g.target = [n];
    renderComposer();
  };
}

function mentionMenu(query) {
  $(".proto-mention")?.remove();
  if (query === null) return;
  const g = current();
  const options = [
    ...g.members.map((n) => [
      n,
      `${AGENTS[n].role} · ${busy[n] && busy[n] !== g.id ? `在「${groups.find((x) => x.id === busy[n]).name}」工作` : "空闲"}`,
    ]),
    ...(g.members.length > 1
      ? [["所有人", `${g.members.join("、")} 都回答`]]
      : []),
  ].filter(([n]) => n.toLowerCase().startsWith(query.toLowerCase()));
  if (!options.length) return;
  const menu = tpl.slash.cloneNode(false);
  menu.classList.add("proto-mention");
  menu.setAttribute("aria-label", "选择发给谁");
  const li = tpl.slash.firstElementChild;
  options.forEach(([n, note], i) => {
    const row = li.cloneNode(false);
    row.style.color = i ? "var(--terminal-muted)" : "var(--terminal-link)";
    row.innerHTML = `<span class="inline-block" style="width: 20ch">@${n}</span>${esc(note)}`;
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      complete(n);
    });
    menu.append(row);
  });
  $("form fieldset").prepend(menu);
}
function complete(name) {
  const input = $('[aria-label="消息"]');
  input.textContent = input.textContent.replace(/@([^\s@]*)$/, `@${name} `);
  placeCaret(input);
  mentionMenu(null);
}
function placeCaret(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

const REPLIES = {
  Aria: "从前端看可以：图标改成按路径导入后首屏 JS 少了 352 KB，hero 图 AVIF 后 210 KB。",
  Bolt: "PR 只动了构建配置和图片，没碰服务端；产物大小对比也附在 PR 描述里了，可以合。",
  Cleo: "我来验收：对比两张 Lighthouse 截图，再跑一遍 bun run check。",
};
function send() {
  const input = $('[aria-label="消息"]');
  const text = input.textContent.trim();
  if (!text) return;
  input.innerHTML = "<p><br></p>";
  mentionMenu(null);
  const g = current();
  const add = (row) => {
    extra[g.id] = [...(extra[g.id] ?? []), row];
  };
  if (state.exec) {
    add(["user", `#112 ${text}`]);
    add(["system", "已作为评论发给 #112 的执行者，排了一次远程运行"]);
    state.exec = false;
    return render();
  }
  const named = g.members.filter((n) => text.includes(`@${n}`));
  const targets = text.includes("@所有人")
    ? [...g.members]
    : named.length
      ? named
      : g.target;
  g.target = targets;
  add(["user", text]);
  // One reply per agent named, in the order named: the order never jumps.
  targets.forEach((n, i) => {
    const elsewhere =
      busy[n] && busy[n] !== g.id
        ? groups.find((x) => x.id === busy[n]).name
        : null;
    const slot = html(`<div class="space-y-3"></div>`);
    add(["node", slot]);
    const fill = (queued) => {
      slot.replaceChildren(
        ...[
          g.members.length > 1
            ? speakerRow(
                n,
                targets.length > 1 ? `${i + 1}/${targets.length}` : "",
              )
            : null,
          workingRow(n, queued ? elsewhere : null),
        ].filter(Boolean),
      );
    };
    fill(Boolean(elsewhere));
    setTimeout(fill, elsewhere ? 3500 : 0, false);
    setTimeout(
      () => {
        const full = REPLIES[n];
        let k = 0;
        const head =
          g.members.length > 1
            ? speakerRow(
                n,
                targets.length > 1 ? `${i + 1}/${targets.length}` : "",
              )
            : null;
        const body = textRow("");
        slot.replaceChildren(...[head, body].filter(Boolean));
        const tick = setInterval(() => {
          k += 2;
          $(".markdown", body).innerHTML = `<p>${esc(full.slice(0, k))}</p>`;
          if (k >= full.length) clearInterval(tick);
        }, 40);
      },
      (elsewhere ? 4500 : 1200) + i * 700,
    );
  });
  render();
}

function wireComposer() {
  const input = $('[aria-label="消息"]');
  if (!input) return;
  const placeholder = input.parentElement.querySelector('[aria-hidden="true"]');
  input.addEventListener("input", () => {
    if (placeholder)
      placeholder.style.display = input.textContent ? "none" : "";
    const m = /@([^\s@]*)$/.exec(input.textContent);
    mentionMenu(m ? m[1] : null);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const first = $(".proto-mention li");
      if (first) return complete(first.textContent.match(/^@(\S+)/)[1]);
      send();
      if (placeholder) placeholder.style.display = "";
    }
    if (e.key === "Escape") mentionMenu(null);
  });
}

// --- the side panel: a 群 tab beside 概览, 任务, 定时, 待处理 -------------------

const panes = {};
function setupPanel() {
  const panel = $("#workspace-panel");
  if (!panel) return;
  for (const t of $$("template[data-pane]"))
    panes[t.dataset.pane] = t.innerHTML;
  const list = $('[role="tablist"]', panel);
  const first = $$('[role="tab"]', list)[0];
  const tab = first.cloneNode(true);
  tab.textContent = "群";
  tab.dataset.pane = "group";
  first.before(tab);
  const ids = ["group", "overview", "tasks", "routines", "inbox"];
  $$('[role="tab"]', list).forEach((t, i) => {
    t.dataset.pane = ids[i];
    t.addEventListener("click", () => {
      state.panel = ids[i];
      state.taskOpen = false;
      renderPanel();
    });
  });
  const full = $('a[aria-label="在全窗口中打开"]', panel);
  if (full) full.href = "workspace.html";
}
function renderPanel() {
  const panel = $("#workspace-panel");
  if (!panel) return;
  const list = $('[role="tablist"]', panel);
  const active = state.panel === "task" ? "tasks" : state.panel;
  for (const t of $$('[role="tab"]', list)) {
    const on = t.dataset.pane === active;
    t.dataset.state = on ? "active" : "inactive";
    t.setAttribute("aria-selected", on);
    if (on) {
      const ind = $('[data-slot="tabs-indicator"]', list);
      ind.style.width = `${t.offsetWidth}px`;
      ind.style.height = `${t.offsetHeight}px`;
      ind.style.transform = `translate(${t.offsetLeft}px, ${t.offsetTop}px)`;
    }
  }
  const body = $(".min-h-0.flex-1.overflow-y-auto.p-3", panel);
  const pane = state.taskOpen
    ? taskPane()
    : active === "group"
      ? groupPane()
      : (panes[active] ?? "");
  body.innerHTML = `<div role="tabpanel" class="flex-1 text-xs/relaxed outline-none">${pane}</div>`;
  body.scrollTop = 0;
  if (active === "tasks" && !state.taskOpen) {
    for (const b of $$("li button", body))
      if (b.textContent.includes("#112")) b.addEventListener("click", openTask);
  }
  if (state.taskOpen) patchTaskDetail(body);
  if (active === "group") wireGroupPane(body);
}
function openTask() {
  state.panel = "task";
  state.taskOpen = true;
  renderPanel();
  showPanelOnPhone();
}
function openGroupPanel() {
  state.panel = "group";
  state.taskOpen = false;
  renderPanel();
}

const taskRowHtml = () => {
  // The panel's own task row, from the task list.
  const t = document.createElement("template");
  t.innerHTML = panes.tasks ?? "";
  const row = $$("li", t.content).find((li) => li.textContent.includes("#112"));
  return row ? row.outerHTML : "";
};
function groupPane() {
  const g = current();
  const prop = (dt, dd) =>
    `<dt class="text-xs leading-8 text-muted-foreground">${dt}</dt><dd class="flex min-w-0 flex-col justify-center gap-1 py-1">${dd}</dd>`;
  const select = (value) =>
    `<button type="button" class="flex w-fit items-center justify-between gap-1.5 rounded-none border border-input bg-transparent py-2 pr-2 pl-2.5 text-xs whitespace-nowrap" style="height:2rem">${value}<span aria-hidden="true" class="text-muted-foreground">⌄</span></button>`;
  const member = (n) => {
    const where = busy[n]
      ? busy[n] === g.id
        ? "在本群工作"
        : `在「${groups.find((x) => x.id === busy[n]).name}」工作`
      : "空闲";
    return `<div class="flex items-center gap-2 text-sm">${avatar(n, "size-5")}<span class="min-w-0 flex-1 truncate">${n}<span class="ml-2 text-xs text-muted-foreground">${AGENTS[n].role}</span></span><span class="text-xs text-muted-foreground">${where}</span>${g.members.length > 1 ? `<button type="button" data-remove="${n}" class="text-xs text-muted-foreground hover:text-foreground">移除</button>` : ""}</div>`;
  };
  const others = Object.keys(AGENTS).filter((n) => !g.members.includes(n));
  const hasTask = g.id === "g1" && state.created;
  return `<article class="space-y-4">
    <header class="space-y-1">
      <h2 class="min-w-0 flex-1 text-base font-semibold wrap-anywhere">${esc(g.dm ? `与 ${g.name} 的私聊` : g.name)}</h2>
      <p class="text-xs text-muted-foreground tabular-nums">${g.dm ? "私聊 · 原来的对话，历史都在" : `群 · 由你创建 · ${g.created}`}</p>
    </header>
    <dl class="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm bg-muted/50 px-3 py-2">
      ${g.dm ? "" : prop("状态", select(g.status))}
      ${prop("成员", g.members.map(member).join("") + (others.length ? `<div class="flex flex-wrap gap-x-3 text-xs text-muted-foreground">${others.map((n) => `<button type="button" data-invite="${n}" class="inline-flex items-center gap-1 hover:text-foreground">＋ 邀请 ${avatar(n, "size-4")}${n}</button>`).join("")}</div>` : ""))}
      ${prop("记忆", `<span class="text-xs leading-6">对话上下文只在本群；各智能体的长期记忆照常写入，召回时标出来源群 · <button type="button" class="underline underline-offset-4">本群不写入</button></span>`)}
    </dl>
    ${
      g.dm
        ? `<p class="text-xs text-muted-foreground">邀请别的智能体，私聊就成了一个群；也可以从这里的讨论起草任务。</p>`
        : `
    <section class="space-y-2">
      <div class="flex items-center justify-between"><h3 class="text-xs font-medium text-muted-foreground">简报</h3><button type="button" class="text-xs text-muted-foreground hover:text-foreground">让 ${g.target[0]} 更新</button></div>
      <div class="border-l-2 border-foreground pl-3"><div class="markdown text-sm"><p><strong>目标</strong>&emsp;${esc(g.goal)}</p>${g.decided.length ? `<p><strong>已定</strong></p><ul>${g.decided.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : ""}</div></div>
    </section>`
    }
    <section class="space-y-1">
      <div class="flex items-center justify-between"><h3 class="text-xs font-medium text-muted-foreground">任务</h3><button type="button" data-draft class="text-xs text-muted-foreground hover:text-foreground">＋ 起草任务</button></div>
      ${hasTask ? `<ul class="-mx-2" data-task-row>${taskRowHtml()}</ul>` : `<p class="text-xs text-muted-foreground">还没有任务。点「起草任务」或在对话里说「整理成任务」，智能体会在对话里给出草稿。</p>`}
    </section>
    <section class="space-y-1">
      <h3 class="text-xs font-medium text-muted-foreground">Artifact</h3>
      ${hasTask ? `<p class="text-sm">Lighthouse 前后对比 <span class="text-xs text-muted-foreground">· 第 1 版 · #112</span></p>` : `<p class="text-xs text-muted-foreground">还没有。</p>`}
    </section>
  </article>`;
}
function wireGroupPane(body) {
  const g = current();
  body.addEventListener("click", (e) => {
    const t = e.target.closest(
      "[data-remove],[data-invite],[data-draft],[data-task-row] button",
    );
    if (!t) return;
    if (t.dataset.remove) {
      g.members = g.members.filter((n) => n !== t.dataset.remove);
      g.target = g.target.filter((n) => n !== t.dataset.remove);
      if (!g.target.length) g.target = [g.members[0]];
      extra[g.id] = [
        ...(extra[g.id] ?? []),
        ["system", `你移除了 ${t.dataset.remove}，它说过的话保留`],
      ];
    } else if (t.dataset.invite) {
      g.members.push(t.dataset.invite);
      extra[g.id] = [
        ...(extra[g.id] ?? []),
        [
          "system",
          `你邀请了 ${t.dataset.invite}，它第一次被点名时会先读简报和最近的消息`,
        ],
      ];
      if (g.dm) {
        g.dm = false;
        groups.push(g);
        dms.splice(dms.indexOf(g), 1);
        g.name = g.members.join("、");
      }
    } else if (t.dataset.draft !== undefined) {
      if (g.id === "g1") {
        state.created = false;
      }
    } else {
      return openTask();
    }
    render();
  });
}
// The task's detail: its source group among the properties, and the
// discussion button opens that group instead of messaging one agent.
function taskPane() {
  return panes.task ?? "";
}
function patchTaskDetail(root) {
  const dl = $("dl", root);
  if (dl && !$(".proto-source", dl)) {
    dl.append(
      html(
        `<dt class="proto-source text-xs leading-8 text-muted-foreground">来源</dt>`,
      ),
    );
    dl.append(
      html(
        `<dd class="flex min-w-0 items-center gap-2 leading-8">${stack(["Aria", "Bolt"], "size-4", 4)}<a href="index.html?g=g1" class="truncate text-foreground underline underline-offset-4">首页首屏加载优化</a><span class="text-xs text-muted-foreground">第 2–8 条</span></dd>`,
      ),
    );
  }
  for (const b of $$("button", root)) {
    if (b.textContent.includes("让智能体反馈")) {
      b.lastChild.textContent = "在群里讨论";
      b.addEventListener("click", () => select("g1"));
    }
    if (b.textContent.trim() === "任务")
      b.addEventListener("click", () => {
        state.taskOpen = false;
        state.panel = "tasks";
        renderPanel();
      });
  }
}

// --- the sidebar: one shell for the chat and the full window ---------------------

function sidebar() {
  let aside = $("aside");
  if (!aside && page === "home") {
    // Home gains the full window's sidebar on wide screens.
    aside = $("#tpl-sidebar-src").content.firstElementChild.cloneNode(true);
    aside.classList.remove("md:flex");
    aside.classList.add("proto-home-side");
    const shell = document.body.querySelector(":scope > div.flex.h-dvh");
    const wrap = html(`<div class="flex h-dvh w-full min-h-0"></div>`);
    shell.before(wrap);
    shell.classList.add("min-w-0", "flex-1");
    wrap.append(aside, shell);
    // 对话 is where we are.
    for (const a of $$("nav a", aside)) {
      const isChat = a.getAttribute("href") === "/";
      a.classList.toggle("bg-sidebar-accent", isChat);
      a.classList.toggle("font-medium", isChat);
      a.classList.toggle("text-foreground", isChat);
      if (!isChat) a.href = "workspace.html";
    }
  }
  if (!aside) return;
  for (const a of $$("nav a", aside))
    if (a.getAttribute("href") === "/") a.href = "index.html";
  const agents = $('section[aria-labelledby="sidebar-agents"]', aside);
  let section = $(".proto-groups", aside);
  if (!section) {
    section = agents.cloneNode(true);
    section.classList.add("proto-groups");
    section.classList.remove("min-h-0");
    $("h2", section).textContent = "群";
    $("h2", section).id = "sidebar-groups";
    section.setAttribute("aria-labelledby", "sidebar-groups");
    $("button", section).setAttribute("aria-label", "新建群");
    $("button", section).title = "新建群";
    $("button", section).addEventListener("click", newGroup);
    agents.before(section);
    agents.classList.remove("mt-5");
    agents.classList.add("mt-4");
  }
  const rowClass = $("ul button", agents).className.replace(
    / ?bg-sidebar-accent| ?font-medium| ?text-foreground(?!\/)/g,
    "",
  );
  const ul = $("ul", section);
  ul.innerHTML = groups
    .map((g) => {
      const on = g.id === state.group && page === "home";
      const working =
        g.members.some((n) => busy[n] === g.id) ||
        (g.id === "g1" && state.created);
      return `<li><button type="button" data-g="${g.id}" title="${esc(g.name)}" class="${rowClass}${on ? " bg-sidebar-accent font-medium text-foreground" : ""}">${stack(g.members.slice(0, 3), "size-5")}<span class="min-w-0 flex-1 truncate text-left">${esc(g.name)}</span>${g.unread ? `<span class="ml-auto text-xs text-foreground tabular-nums">${g.unread}</span>` : working ? `<span aria-hidden="true" class="inline-block size-1.5 shrink-0 bg-foreground motion-safe:animate-pulse"></span>` : ""}</button></li>`;
    })
    .join("");
  for (const b of $$("ul button", agents)) {
    const name = b.title.replace(/^与 | 对话$/g, "");
    const on = page === "home" && state.group === `dm-${name}`;
    b.className =
      rowClass + (on ? " bg-sidebar-accent font-medium text-foreground" : "");
    b.onclick = () => select(`dm-${name}`);
  }
  ul.onclick = (e) => {
    const b = e.target.closest("[data-g]");
    if (b) select(b.dataset.g);
  };
}

function select(id) {
  if (page !== "home") {
    location.href = `index.html?g=${id}`;
    return;
  }
  state.group = id;
  state.exec = false;
  const g = current();
  g.unread = 0;
  if (state.panel === "task") {
    state.panel = "group";
    state.taskOpen = false;
  }
  render();
  showChatOnPhone();
}

// --- new group: the agent dialog, asking for a name and members -----------------

function newGroup() {
  const source = $("#tpl-dialog").content;
  const dialog = source.querySelector('[role="dialog"]').cloneNode(true);
  const overlay = html(
    `<div class="proto-overlay" style="position:fixed;inset:0;z-index:50;background:rgb(0 0 0 / .1);backdrop-filter:blur(4px)"></div>`,
  );
  $('[data-slot="dialog-title"]', dialog).textContent = "新建群";
  // Keep the name field; replace the rest of the body with members and a goal.
  const nameField = $("#agent-name", dialog).closest("[data-slot=field], div");
  const fieldClass = nameField.className;
  const label = $("label", nameField);
  label.textContent = "名称";
  const input = $("input", nameField);
  input.placeholder = "例如：首页首屏加载优化";
  input.value = "";
  const body = nameField.parentElement;
  for (const el of [...body.children]) if (el !== nameField) el.remove();
  const labelClass = label.className;
  body.append(
    html(
      `<div class="${fieldClass}"><span class="${labelClass}">成员 <span class="text-muted-foreground">至少一个智能体；只有一个也是群</span></span><div class="grid gap-1 pt-1">${Object.keys(
        AGENTS,
      )
        .map(
          (n, i) =>
            `<label class="flex items-center gap-2 text-xs"><input type="checkbox" ${i === 0 ? "checked" : ""} data-n="${n}">${avatar(n, "size-5")}${n}<span class="text-muted-foreground">${AGENTS[n].role}</span></label>`,
        )
        .join("")}</div></div>`,
    ),
  );
  body.append(
    html(
      `<div class="${fieldClass}"><label class="${labelClass}">目标 <span class="text-muted-foreground">可选，之后智能体会帮你补全简报</span></label><textarea rows="2" class="${input.className}" style="height:auto" placeholder="这件事要达成什么"></textarea></div>`,
    ),
  );
  // The stepper of the agent wizard has no place here.
  for (const el of $$("ol, [role=tablist], nav", dialog)) el.remove();
  const buttons = $$("button", dialog);
  const submit = buttons.find((b) => b.textContent.includes("下一步"));
  if (submit) {
    submit.textContent = "创建";
    submit.type = "button";
  }
  const close = () => {
    overlay.remove();
    dialog.remove();
  };
  for (const b of buttons)
    if (b.textContent.includes("取消") || b.dataset.slot === "dialog-close")
      b.addEventListener("click", close);
  overlay.addEventListener("click", close);
  submit?.addEventListener("click", () => {
    const members = $$("input[data-n]:checked", dialog).map((c) => c.dataset.n);
    const name = input.value.trim() || "新的群";
    if (!members.length) return;
    const id = `g${Date.now()}`;
    groups.unshift({
      id,
      name,
      members,
      status: "讨论中",
      target: [members[0]],
      unread: 0,
      created: "刚刚",
      goal: $("textarea", dialog).value.trim() || "（还没写）",
      decided: [],
      log: () => [
        ["system", `你创建了群「${name}」，邀请了 ${members.join("、")}`],
      ],
    });
    close();
    if (page === "home") select(id);
    else sidebar();
  });
  document.body.append(overlay, dialog);
  input.focus();
}

// --- phones: the 对话 / 工作区 switch ------------------------------------------

function phoneSwitch() {
  const bar = $('[aria-label="工作区面板"]');
  if (!bar) return;
  const [chat, work] = $$("button", bar);
  chat.onclick = showChatOnPhone;
  work.onclick = showPanelOnPhone;
  if (state.phone === "panel") showPanelOnPhone();
  else showChatOnPhone();
}
function setPhone(panel) {
  const chatBox = $("#main > div:first-child");
  const panelBox = $("#workspace-panel");
  const bar = $('[aria-label="工作区面板"]');
  if (!chatBox || !panelBox || !bar) return;
  chatBox.classList.toggle("hidden", panel);
  chatBox.classList.add("md:block");
  panelBox.classList.toggle("hidden", !panel);
  panelBox.classList.add("md:flex");
  const [chat, work] = $$("button", bar);
  chat.classList.toggle("bg-muted", !panel);
  work.classList.toggle("bg-muted", panel);
  if (panel) renderPanel();
}
function showChatOnPhone() {
  setPhone(false);
}
function showPanelOnPhone() {
  if (innerWidth < 768) setPhone(true);
}

// --- go --------------------------------------------------------------------------

function render() {
  renderHero();
  renderLog();
  renderComposer();
  sidebar();
  renderPanel();
}

if (page === "home") {
  sidebar();
  setupPanel();
  phoneSwitch();
  wireComposer();
  const trigger = $('button[aria-label^="正在与"]');
  trigger?.addEventListener("click", toggleMenu);
  render();
  if (params.get("menu")) toggleMenu();
  if (params.get("new")) newGroup();
} else {
  sidebar();
  const main = $('[aria-label="属性"]')?.parentElement ?? document;
  patchTaskDetail(main);
  if (params.get("new")) newGroup();
}
