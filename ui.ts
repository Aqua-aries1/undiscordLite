/* eslint-disable simple-header/header -- code ported from MIT-licensed Undiscord Lite; port credit below */
// @ts-nocheck
/*
 * Ported from Undiscord Lite 1.3.0-zh (userscript, MIT, by OrbitalCheese).
 * That repository is no longer public. Undiscord Lite is itself derived from
 * victornpb/undiscord (MIT, https://github.com/victornpb/undiscord); the
 * original copyright notice is kept in THIRD-PARTY-NOTICES.md.
 * Mechanical split: bundled module registry converted to real ESM. Only the
 * marked adapter functions were rewritten; delete/search logic is upstream
 * verbatim.
 */

// ============================================================================
// UNDISCORD-LITE — UI LAYER
// ----------------------------------------------------------------------------
// Owns the panel HTML, CSS, every event binding, and the run orchestrators —
// the meta-orchestrator startAction(), per-snapshot dispatchers
// runSearchModeFromForm / runImportModeFromForm, and the Batch Selection
// queue flow. All Discord page I/O — token, URL parsing, server-bar injection,
// point-and-click ID capture — happens here. The delete pipeline itself
// lives in undiscord-core.js.
// ============================================================================

const LOG_PREFIX = "[UNDISCORD-LITE]";
import { flushStatusLine } from "./autoFlush";
import UndiscordCore from "./core";
import Drag from "./drag";
import { ImportSource,parseExport, summarizeImport } from "./exportImport";
import { authHeaders, buildContentMatcher, buildExtensionMatcher, canManageMessages, createElm, escapeHTML, fillToken, getAuthorId, getChannelId, getGuildId, insertCss, log, msToHMS, parseCsvList, readLocalStorage, redactHtml, setLogFn, snowflakeToMs, writeLocalStorage } from "./helpers";
import styles from "./styles";
import undiscordTemplate from "./template";
// ============================================================================
// MODULE STATE
// ----------------------------------------------------------------------------
// Singleton core instance + DOM element cache + cross-call mutable state.
// `$` is the panel-scoped selector helper used everywhere below.
// ============================================================================

const undiscordCore = new UndiscordCore();

const ui = {
  undiscordWindow: null,
  logArea: null,
  autoScroll: null,
  // progress handler
  progressMain: null,
  topBarSlot: null, // unified status line above the log — idle hint or running progress
  footerTime: null, // elapsed / remaining readout in the footer's left edge during a run
};
const $ = s => ui.undiscordWindow.querySelector(s);

// Loaded Discord data export (post-parse). Null when no import is active.
// Shape: { messages, channelCount, oldestTs, newestTs } as returned by parseExport().
// When set, startAction() routes the per-snapshot dispatch through
// runImportModeFromForm() and the General / Search filter / Delete filter UI
// sections grey out (CSS via .import-mode).
let importedSet = null;

// One-shot log message printed right after the "Started at..." line. Used by
// startAction to surface notices that would otherwise be wiped by the log-clear
// it does just before kicking off the run. Consumed (and cleared) by onStart.
let pendingStartNotice = null;

// Current batch position, surfaced by core.onJob during a runBatch loop. Reset
// to {1, 1} at the start of each run so single-job runs (which never call
// onJob) display "Job 1/1" in the top bar instead of leftover values.
let currentJobInfo = { i: 1, n: 1 };

/** Streamer-mode redaction. Emits a `redactHtml` dual-span so log lines render either the real value or '••••' depending on the panel's `.streamer-on` class — CSS-toggled, so already-printed log lines re-render the moment the streamer-mode checkbox flips. '@me' passes through verbatim (literal Discord URL token, not a sensitive ID). Empty / null inputs pass through so callers don't have to null-guard. */
function dot(v) {
  if (v == null || v === "") return v;
  if (v === "@me") return "@me";
  return redactHtml(v);
}


// ============================================================================
// QUEUE PARSING & MUTATION
// ----------------------------------------------------------------------------
// The server / channel inputs encode the queued targets:
//   server  : "S1,S2,S3"
//   channel : "C1,C2;;C3"   — semicolons separate per-server groups
// An empty group (";", or "C1;") means server-wide wipe of that server.
// When the channel input has no ';' and the server input has more than one ID,
// the legacy parallel-CSV interpretation is used; Add buttons rewrite the
// inputs to grouped format on the next click.
// ============================================================================

/** Parses the Server / Channel inputs into a flat `[{guildId, channelId}, ...]` target list. Channel entries with no parent server (orphans) are counted but not included in the list. Defaults to reading the live form fields; callers can pass raw strings instead (used by the redundancy check to parse snapshot targets without touching the DOM). */
function parseTargets(guildRaw, channelRaw) {
  if (guildRaw === undefined) guildRaw = $("input#guildId").value;
  if (channelRaw === undefined) channelRaw = $("input#channelId").value;
  guildRaw = guildRaw.trim();
  channelRaw = channelRaw.trim();
  const servers = guildRaw ? guildRaw.split(/\s*,\s*/) : [];

  const targets = [];
  let orphans = 0;

  if (channelRaw.includes(";") || servers.length <= 1) {
    // Grouped format (or single-server, where grouped and legacy are identical).
    const groups = channelRaw
      ? channelRaw.split(/\s*;\s*/).map(g => g.split(/\s*,\s*/).filter(Boolean))
      : [];
    for (let i = 0; i < servers.length; i++) {
      const s = servers[i];
      if (!s) continue;
      const g = groups[i] ?? [];
      if (g.length === 0) targets.push({ guildId: s, channelId: "" });
      else for (const c of g) targets.push({ guildId: s, channelId: c });
    }
    // Channels in groups beyond the server list = orphans.
    for (let i = servers.length; i < groups.length; i++) orphans += groups[i].length;
  } else {
    // Legacy parallel-CSV (multiple servers, no ';' delimiter): each comma in
    // the channel list pairs with the same-index server, last-server clamps.
    const channels = channelRaw.split(/\s*,\s*/);
    const max = Math.max(servers.length, channels.length);
    for (let i = 0; i < max; i++) {
      const g = servers[Math.min(i, servers.length - 1)] ?? "";
      const c = channels[i] ?? "";
      if (!g) { if (c) orphans++; continue; }
      targets.push({ guildId: g, channelId: c });
    }
  }
  return { targets, orphans };
}

/**
 * Appends a (server, channel) pair to the queue.
 *   - Adding (S, '') over (S, channels) absorbs the channels — server-wide wins.
 *   - Adding (S, C) over (S, '') narrows the server-wide entry to just C.
 *   - Plain duplicates surface as a "<id> is already in the queue." log line.
 */
function addPair(server, channel) {
  if (!server) return;
  const guildInput = $("input#guildId");
  const channelInput = $("input#channelId");

  const { servers, groups } = readQueue(guildInput.value, channelInput.value);

  let idx = servers.indexOf(server);
  const wasNew = idx === -1;
  if (wasNew) {
    servers.push(server);
    groups.push([]);
    idx = servers.length - 1;
  }

  if (channel === "") {
    // Server-wide. Absorb existing channel-specifics for this server.
    if (!wasNew && groups[idx].length === 0) {
      return log.info(`${dot(server)} 已按服务器范围加入队列。`);
    }
    if (!wasNew && groups[idx].length > 0) {
      log.warn(`服务器范围删除 ${dot(server)} 已吸收 ${groups[idx].length} 个频道范围条目。`);
    }
    groups[idx] = [];
  } else {
    // Channel-specific. If the server is currently server-wide, NARROW it to
    // this channel. (Add Channel after Add Server means "actually, just this one".)
    if (!wasNew && groups[idx].length === 0) {
      log.info(`服务器范围删除 ${dot(server)} 已缩小为 ${dot(server)}:${dot(channel)}。`);
      groups[idx] = [channel];
    } else {
      if (groups[idx].includes(channel)) {
        return log.info(`${dot(server)}:${dot(channel)} 已在队列中。`);
      }
      groups[idx].push(channel);
    }
  }

  writeQueue(servers, groups);
}

/** Reads the Server / Channel input values into `{ servers: [], groups: [[], []...] }`. Migrates legacy parallel-CSV (servers duplicated to align with channels) into grouped form. */
function readQueue(guildVal, channelVal) {
  const guildRaw = guildVal.trim();
  const channelRaw = channelVal.trim();
  const servers = guildRaw ? guildRaw.split(/\s*,\s*/) : [];

  // Already grouped, or single server (where formats are equivalent).
  if (channelRaw.includes(";") || servers.length <= 1) {
    const groups = channelRaw
      ? channelRaw.split(/\s*;\s*/).map(g => g.split(/\s*,\s*/).filter(Boolean))
      : [];
    while (groups.length < servers.length) groups.push([]);
    return { servers, groups };
  }

  // Legacy parallel-CSV migration: dedup servers and merge their channels.
  const channels = channelRaw.split(/\s*,\s*/);
  const tmpGroups = servers.map(() => []);
  for (let i = 0; i < channels.length; i++) {
    const idx = Math.min(i, servers.length - 1);
    if (channels[i]) tmpGroups[idx].push(channels[i]);
  }
  const uniqueServers = [];
  const uniqueGroups = [];
  for (let i = 0; i < servers.length; i++) {
    const existing = uniqueServers.indexOf(servers[i]);
    if (existing === -1) {
      uniqueServers.push(servers[i]);
      uniqueGroups.push([...tmpGroups[i]]);
    } else {
      for (const c of tmpGroups[i]) {
        if (!uniqueGroups[existing].includes(c)) uniqueGroups[existing].push(c);
      }
    }
  }
  return { servers: uniqueServers, groups: uniqueGroups };
}

/** Writes a `{ servers, groups }` queue back into the Server / Channel input fields and refreshes the top-bar synopsis. */
function writeQueue(servers, groups) {
  $("input#guildId").value = servers.join(",");
  $("input#channelId").value = groups.map(g => g.join(",")).join(";");
  renderQueue();
}

/** Removes every entry for `server` from the queue (server-wide and per-channel). */
function removeServer(server) {
  const { servers, groups } = readQueue($("input#guildId").value, $("input#channelId").value);
  const idx = servers.indexOf(server);
  if (idx === -1) {
    log.info(`${dot(server)} 不在队列中，无需移除。`);
    return;
  }
  servers.splice(idx, 1);
  groups.splice(idx, 1);
  log.info(`已从队列移除 ${dot(server)}。`);
  writeQueue(servers, groups);
}

/** Drops `@me` from the queue when it has no DM channels attached. A bare `@me` (no DM channels) is unrunnable — server-wide @me has no valid Discord search endpoint. */
function cleanupOrphanedMe() {
  const { servers, groups } = readQueue($("input#guildId").value, $("input#channelId").value);
  const idx = servers.indexOf("@me");
  if (idx === -1) return; // no @me — nothing to do
  if (groups[idx].length > 0) return; // @me still has DM channels — keep it
  servers.splice(idx, 1);
  groups.splice(idx, 1);
  log.warn("已从队列移除 @me——@me 不能作为服务器范围删除目标，请使用“添加私信”，或在“频道 ID”中使用“选择”来捕获指定私信。");
  writeQueue(servers, groups);
}

/** Removes one (server, channel) pair from the queue. When the last channel under a server is removed, the server widens back to a server-wide wipe — except for `@me`, which is dropped entirely (a server-wide @me is unrunnable). */
function removeChannel(server, channel) {
  const { servers, groups } = readQueue($("input#guildId").value, $("input#channelId").value);
  const idx = servers.indexOf(server);
  if (idx === -1) {
    log.info(`${dot(server)}:${dot(channel)} 不在队列中，无需移除。`);
    return;
  }
  if (groups[idx].length === 0) {
    log.info(`${dot(server)} 已按服务器范围加入队列——请点击服务器旁的“删除”来移除它。`);
    return;
  }
  const cIdx = groups[idx].indexOf(channel);
  if (cIdx === -1) {
    log.info(`${dot(server)}:${dot(channel)} 不在队列中，无需移除。`);
    return;
  }
  groups[idx].splice(cIdx, 1);
  if (groups[idx].length === 0) {
    if (server === "@me") {
      // Drop @me entirely — a bare @me with no DM channels has no valid
      // search endpoint and would error at run time.
      servers.splice(idx, 1);
      groups.splice(idx, 1);
      log.info(`已移除 ${dot(server)}:${dot(channel)}——这是队列中的最后一个私信频道，已同时移除 @me（服务器范围的 @me 不是有效删除目标）。`);
    } else {
      log.info(`已移除 ${dot(server)}:${dot(channel)}——这是最后一个频道，服务器已恢复为服务器范围删除。`);
    }
  } else {
    log.info(`已从队列移除 ${dot(server)}:${dot(channel)}。`);
  }
  writeQueue(servers, groups);
}


// ============================================================================
// TOP-BAR / RENDER
// ----------------------------------------------------------------------------
// Idle-state synopsis printed above the log: queue summary, import summary,
// or empty-queue hint. Running-state text is owned by bindCoreEvents().
// ============================================================================

/** Triggered after every queue mutation to refresh the top-bar synopsis. */
function renderQueue() {
  renderTopBar();
}

/** Repaints the top-bar idle status line — one of: import summary, queue synopsis, or empty-queue hint. Bails out during an active run so it can't overwrite onProgress output. */
function renderTopBar() {
  if (!ui.topBarSlot) return; // not yet cached (called pre-init)
  if (undiscordCore.state.running) return; // onProgress owns the slot during a run

  if (importedSet) {
    const { messages, channelCount, oldestTs, newestTs } = importedSet;
    const fmt = ts => ts ? new Date(ts).toISOString().slice(0, 10) : "—";
    ui.topBarSlot.innerHTML =
      `<span class="status-line">已导入 ${messages.length.toLocaleString()} 条消息，来自 ${channelCount} 个频道。` +
      `| 起始日期：${fmt(oldestTs)} | 结束日期：${fmt(newestTs)} |</span>`;
    return;
  }

  const { targets } = parseTargets();
  if (targets.length === 0) {
    ui.topBarSlot.innerHTML =
      "<span class=\"status-line status-empty\">队列为空——请添加目标或导入数据导出。</span>";
    return;
  }

  // Per-category counts. Servers = distinct guildIds (incl @me). Channels =
  // entries with a specific channel ID. Server-wipes / Channel-wipes split the
  // entries by kind. Authors = comma-separated count from the Author ID field;
  // an empty field is read as 1 (defaults to self at run time).
  const servers = new Set(targets.map(t => t.guildId));
  const channelWipes = targets.filter(t => t.channelId).length;
  const serverWipes = targets.length - channelWipes;
  const authorCount = parseCsvList($("input#authorId").value).length || 1;

  ui.topBarSlot.innerHTML =
    `<span class="status-line">就绪：服务器 ${servers.size} 个 | ` +
    `频道 ${channelWipes} 个 | ` +
    `服务器范围 ${serverWipes} 个 | ` +
    `频道范围 ${channelWipes} 个 | ` +
    `作者 ${authorCount} 个 |</span>`;
}


// ============================================================================
// VERIFY ACTION
// ----------------------------------------------------------------------------
// Click handler for the 📋 Verify button. Walks every form input and prints a
// structured snapshot of the current run configuration to the log so the user
// can sanity-check it before clicking Delete. Read-only — never clears the
// log. Streamer mode redacts sensitive IDs (author, mentions, server /
// channel, snowflake bounds) the same way the message-preview log does.
// ============================================================================

/** Prints the active run configuration to the log without starting a run. Wired to the Verify button. */
function verifyAction() {
  const sm = $("input#streamerMode").checked;

  log.info("── 配置校验 ──");

  if (importedSet) {
    const { messages, channelCount, oldestTs, newestTs } = importedSet;
    const fmt = ts => ts ? new Date(ts).toISOString().slice(0, 10) : "—";
    log.info("模式：导入（已跳过实时搜索筛选）");
    log.info(`导入数据：${messages.length.toLocaleString()} 条消息 · ${channelCount} 个频道 · ${fmt(oldestTs)} → ${fmt(newestTs)}`);
  } else {
    log.info("模式：实时搜索");
    const authorVal = $("input#authorId").value.trim();
    log.info(`作者 ID：${authorVal ? dot(authorVal) : "（为空 = 不按作者筛选，会删除所有作者的消息）"}`);

    const { targets, orphans } = parseTargets();
    if (!targets.length) {
      log.info("队列：为空");
    } else {
      const grouped = new Map();
      for (const t of targets) {
        if (!grouped.has(t.guildId)) grouped.set(t.guildId, []);
        if (t.channelId) grouped.get(t.guildId).push(t.channelId);
      }
      log.info(`队列：${grouped.size} 个服务器 / ${targets.length} 个目标`);
      for (const [server, channels] of grouped) {
          const sLabel = server === "@me" ? "@me（私信）" : `服务器 ${dot(server)}`;
        if (channels.length === 0) {
          log.info(`  · ${sLabel}：服务器范围删除`);
        } else {
          const chList = sm ? "" : ` — ${channels.join(", ")}`;
          log.info(`  · ${sLabel}：${channels.length} 个频道${chList}`);
        }
      }
      if (orphans) log.warn(`  · ${orphans} 个无父服务器的频道将被跳过（任务开始时生效）。`);
    }
    const keepList = readExcludeChannelList();
    if (keepList.length) {
      log.info(`排除频道（保留）：${keepList.length} 个${sm ? "" : " — " + keepList.join(", ")}（服务器范围删除时保留这些频道）`);
    }
  }

  // Search filter is meaningless in import mode (no API call to filter).
  if (!importedSet) {
    const search = $("input#search").value.trim();
    const hasFlags = ["hasLink","hasImage","hasVideo","hasSound","hasSticker","hasPoll","hasEmbed","hasForward"]
      .filter(id => $(`input#${id}`).checked)
      .map(id => ({ link: "链接", image: "图片", video: "视频", sound: "音频", sticker: "贴纸", poll: "投票", embed: "嵌入内容", forward: "转发" }[id.slice(3).toLowerCase()] || id.slice(3).toLowerCase()));
    const mentionsVal = $("input#mentionsId").value.trim();
    const mentionEv = $("input#mentionEveryone").checked;
    const pinned = $("select#pinnedMode").value;
    const excludeNsfw = $("input#excludeNsfw").checked;
    const parts = [];
    if (search) parts.push(`文本“${search}”`);
    if (hasFlags.length) parts.push(`包含 ${hasFlags.join("、")}`);
    if (mentionsVal) parts.push(`@用户 ${dot(mentionsVal)}`);
    if (mentionEv) parts.push("包含 @everyone / @here");
    if (pinned !== "exclude") parts.push(`置顶：${({ include: "包含", only: "仅限" }[pinned] || pinned)}`);
    if (excludeNsfw) parts.push("排除 NSFW");
    log.info(`搜索筛选：${parts.length ? parts.join(" · ") : "（无）"}`);
  }

  // Delete filter (some toggles still apply in import mode — content text and
  // attachment-MIME inferences both work since the export carries that data).
  const exSearch = $("input#excludeSearch").value.trim();
  const exMatch = $("select#excludeMatchMode").value;
  const exFlags = ["excludeLink","excludeImage","excludeVideo","excludeSound","excludeSticker","excludePoll","excludeEmbed","excludeForward"]
    .filter(id => $(`input#${id}`).checked)
    .map(id => ({ link: "链接", image: "图片", video: "视频", sound: "音频", sticker: "贴纸", poll: "投票", embed: "嵌入内容", forward: "转发" }[id.slice(7).toLowerCase()] || id.slice(7).toLowerCase()));
  const exMentionsVal = $("input#excludeMentionsId").value.trim();
  const exMentionEv = $("input#excludeMentionEveryone").checked;
  const delParts = [];
  if (exSearch) delParts.push(`跳过文本“${exSearch}”（${exMatch}）`);
  if (exFlags.length) delParts.push(`跳过 ${exFlags.join("、")}`);
  if (exMentionsVal) delParts.push(`跳过 @用户 ${dot(exMentionsVal)}`);
  if (exMentionEv) delParts.push("跳过 @everyone / @here");
  log.info(`删除筛选：${delParts.length ? delParts.join(" · ") : "（无）"}`);

  // Intervals — Messages-interval (snowflakes) wins over Date-interval.
  const minId = $("input#minId").value.trim();
  const maxId = $("input#maxId").value.trim();
  const minDate = $("input#minDate").value.trim();
  const maxDate = $("input#maxDate").value.trim();
  if (minId || maxId) {
    log.info(`消息范围：${minId ? dot(minId) : "（频道起点）"} → ${maxId ? dot(maxId) : "（现在）"}`);
    if (minDate || maxDate) log.info("  · 同时设置了日期范围——运行时以消息范围为准。");
  } else if ((minDate && minDate !== "2015-01-01T00:00") || maxDate) {
    log.info(`日期范围：${minDate || "2015-01-01T00:00"} → ${maxDate || "（现在）"}`);
  }

  log.info(`延迟：搜索 ${$("input#searchDelay").dataset.ms}ms · 删除 ${$("input#deleteDelay").dataset.ms}ms`);
  log.info("── 校验结束 ──");
}


// ============================================================================
// INIT — ENTRY POINT
// ----------------------------------------------------------------------------
// Called once on script load: injects the panel HTML/CSS, mounts the trash
// icon (server-bar by default, with a bottom-right floating-action-button as
// fallback), registers Ctrl+Shift+D, and binds every panel button to its
// handler. After this returns, the script is idle until the user clicks Delete.
// ============================================================================

/** Mounts the panel, the trash icons, the keyboard shortcut, and binds every input/button to its handler. Called once at script load. */
let toggleWindowRef = null;

function initUI() {
  if (initUI.mounted) return initUI.dispose;

  const styleEl = insertCss(styles);

  ui.undiscordWindow = createElm(undiscordTemplate);
  document.body.appendChild(ui.undiscordWindow);

  // Draggable by the header, resizable from 8 edge/corner handles.
  new Drag({ elm: ui.undiscordWindow, moveHandle: $(".header") });

  // The open button lives in Discord's chat-header toolbar (HeaderBarIcon),
  // registered by index.tsx's patch — no floating button, no server-rail DOM
  // injection and no 1 s re-inject polling anymore.

  // Keyboard shortcut: Ctrl+Shift+D toggles the panel.
  const keyHandler = e => {
    if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === "KeyD") {
      e.preventDefault();
      e.stopPropagation();
      toggleWindow();
    }
  };
  document.addEventListener("keydown", keyHandler, true);

  // Window-fit rescue: the panel's max-* viewport rules stop it growing past a
  // shrunk window, but a dragged panel keeps its inline top/left, so shrinking
  // the Discord window can leave it hanging off the right/bottom edge. Pull it
  // back on resize. (Undragged panels are CSS right-anchored and track the
  // window on their own — the empty left/top check skips those.)
  const fitToViewport = () => {
    const win = ui.undiscordWindow;
    if (!win || win.style.display === "none") return;
    if (!win.style.left && !win.style.top) return;
    const rect = win.getBoundingClientRect();
    if (rect.right > window.innerWidth) win.style.left = `${Math.max(0, window.innerWidth - rect.width - 4)}px`;
    if (rect.bottom > window.innerHeight) win.style.top = `${Math.max(0, window.innerHeight - rect.height - 4)}px`;
  };
  window.addEventListener("resize", fitToViewport);

  /** Toggles the panel open/closed. */
  function toggleWindow() {
    const opening = ui.undiscordWindow.style.display === "none";
    ui.undiscordWindow.style.display = opening ? "" : "none";
    // Opening the panel is exactly when you want to know what auto-flush is
    // about to do to your messages — it is otherwise invisible (no UI, no badge).
    if (opening) log.info(flushStatusLine());
  }

  // Cached elements.
  ui.logArea = $("#logArea");
  ui.autoScroll = $("#autoScroll");
  ui.progressMain = $("#progressBar");
  ui.topBarSlot = $("#topBarSlot");
  ui.footerTime = $("#footerTime");

  $("#hide").onclick = toggleWindow;
  // The primary button is dual-purpose: Delete when idle, Stop when a run is
  // in flight. State is keyed off core's running flag so a single click handler
  // dispatches to the right path; bindCoreEvents flips the label/title in sync.
  $("button#start").onclick = () => {
    if (undiscordCore.state.running) stopAction();
    else startAction();
  };
  $("button#verify").onclick = verifyAction;
  $("button#clear").onclick = () => ui.logArea.innerHTML = "";
  $("button#resetSelection").onclick = () => {
    resetAllSelection();
    log.info("选择已重置为默认值。");
  };
  $("button#queueSelection").onclick = queueSelectionAction;
  $("button#dropBatches").onclick = () => {
    if (selectionQueue.length === 0) return;
    const n = selectionQueue.length;
    selectionQueue = [];
    renderQueueBadge();
    log.info(`已丢弃 ${n} 个已排队批次。`);
  };
  $("button#getAuthor").onclick = () => {
    const id = getAuthorId();
    if (id) $("input#authorId").value = id;
  };
  // Add Server queues (currentServer, '') as a server-wide wipe; the current
  // server is read from Discord's URL. @me is rejected here: server-wide @me
  // has no valid Discord search endpoint. Use "Add DMs" instead.
  $("button#addGuild").onclick = () => {
    const server = getGuildId();
    if (server === "@me") {
      return log.warn("“添加服务器”不适用于私信列表——请在“私信”区域使用“添加私信”来加入当前打开的所有私信。");
    }
    if (server) addPair(server, "");
  };
  // Add Channel queues (currentServer, currentChannel) as a specific-channel entry.
  $("button#addChannel").onclick = () => {
    const server = getGuildId();
    const channel = getChannelId();
    if (server && channel) addPair(server, channel);
  };
  $("button#delGuild").onclick = () => {
    const server = getGuildId();
    if (server) removeServer(server);
  };
  $("button#delChannel").onclick = () => {
    const server = getGuildId();
    const channel = getChannelId();
    if (server && channel) removeChannel(server, channel);
  };
  // Add all DMs: fetch every open DM channel via GET /users/@me/channels and
  // queue each as (@me, <channelId>). Group DMs (type 3) are included unless
  // the "Exclude group DMs" checkbox is ticked. DMs X'd out of the sidebar
  // aren't returned by this endpoint, so they're skipped.
  $("button#addAllDms").onclick = async () => {
    const token = fillToken();
    if (!token) return; // fillToken already logs the error.

    log.info("正在获取当前打开的私信频道…");
    let channels;
    try {
      const resp = await fetch("https://discord.com/api/v9/users/@me/channels", {
        headers: authHeaders(token),
      });
      if (!resp.ok) return log.error(`无法获取私信——Discord 返回状态 ${resp.status}。`);
      channels = await resp.json();
    } catch (err) {
      return log.error("获取私信时发生网络错误：", err);
    }

    const excludeGroups = $("input#excludeGroupDms").checked;
    const dms = channels.filter(c => c.type === 1 || (!excludeGroups && c.type === 3));
    if (!dms.length) return log.info("没有找到当前打开的私信频道。");

    for (const c of dms) addPair("@me", c.id);

    const direct = dms.filter(c => c.type === 1).length;
    const group = dms.filter(c => c.type === 3).length;
    const summary = excludeGroups
      ? `已加入 ${direct} 个私信（已排除群组私信）。`
      : `已加入 ${dms.length} 个私信（其中单聊 ${direct} 个，群组私信 ${group} 个）。`;
    log.info(summary);
  };
  // Clear DMs: strip the @me server entry (and all its DM channels) from the queue.
  $("button#delAllDms").onclick = () => {
    const { servers, groups } = readQueue($("input#guildId").value, $("input#channelId").value);
    const idx = servers.indexOf("@me");
    if (idx === -1) return log.info("队列中没有可移除的私信。");
    const dmCount = groups[idx].length;
    servers.splice(idx, 1);
    groups.splice(idx, 1);
    if (dmCount === 0) {
      log.info("已从队列移除 @me。");
    } else {
      log.info(`已从队列移除 ${dmCount} 个私信。`);
    }
    writeQueue(servers, groups);
  };

  // Live-update the queue counter as the user types, then sanitise on commit
  // (blur after edit). The sanitise step strips orphaned @me so neither manual
  // edits nor channel-field deletions can leave it as an unrunnable phantom.
  $("input#guildId").addEventListener("input", renderQueue);
  $("input#channelId").addEventListener("input", renderQueue);
  $("input#guildId").addEventListener("change", cleanupOrphanedMe);
  $("input#channelId").addEventListener("change", cleanupOrphanedMe);
  renderQueue();
  renderQueueBadge();

  // Import data export — folder picker, summary, clear button.
  bindImportControls();

  // Stepper controls for search/delete delays. User-driven changes go straight
  // to core options + decay baseline. Rate-limit bumps inside core can still
  // push the effective delay above the user's max temporarily; it decays back
  // to the baseline.
  setDelayDisplay("searchDelay", SEARCH_DEFAULT);
  setDelayDisplay("deleteDelay", DELETE_DEFAULT);
  bindStepper("searchDelay", SEARCH_MIN, SEARCH_MAX, SEARCH_STEP, SEARCH_DEFAULT, "_userSearchDelay");
  bindStepper("deleteDelay", DELETE_MIN, DELETE_MAX, DELETE_STEP, DELETE_DEFAULT, "_userDeleteDelay");

  // Strip Discord message links pasted into the message-interval inputs down to the trailing ID.
  bindLinkStrip($("input#minId"));
  bindLinkStrip($("input#maxId"));

  // Paste handling for user-ID fields:
  //   - Author ID and Skip mentions support multiple IDs (Cartesian batching for
  //     authors, post-filter list-check for skips). Multi-paste appends with dedup.
  //   - Include mentions (Search filter) is single-value because Discord's
  //     `mentions=` query param only accepts one ID per request. Pastes overwrite.
  bindMultiUserPaste($("input#authorId"), "作者 ID");
  bindSingleUserPaste($("input#mentionsId"), "提及用户");
  bindMultiUserPaste($("input#excludeMentionsId"), "跳过提及");
  // Import-mode exclusion inputs — same paste behaviour (snowflake-shaped IDs
  // append with dedup; non-ID clipboards fall through to native paste).
  bindMultiUserPaste($("input#importExcludeServers"), "导入：排除服务器");
  bindMultiUserPaste($("input#importExcludeChannels"), "导入：排除频道");
  bindMultiUserPaste($("input#importExcludeUsers"), "导入：排除私信用户");
  // Live-search channel exclusion list — comma-separated channel / thread IDs
  // that the upcoming server-wide wipe must leave untouched.
  bindMultiUserPaste($("input#excludeChannelIds"), "排除频道（保留）");

  // Point-and-click ID capture: each Select button arms a global click
  // listener; the next click on a Discord user/avatar/message/server-icon/
  // channel extracts the relevant ID. Hold Shift to capture multiple in a row.
  bindSelector("selectAuthor", "authorId", "user", "作者 ID");
  bindSelector("selectGuild", "guildId", "server", "服务器 ID");
  bindSelector("selectChannel", "channelId", "channel", "频道 ID");
  bindSelector("selectMentions", "mentionsId", "user-single", "提及用户");
  bindSelector("selectExcludeMentions","excludeMentionsId","user", "跳过提及");
  bindSelector("selectMinId", "minId", "message", "晚于此消息 ID");
  bindSelector("selectMaxId", "maxId", "message", "早于此消息 ID");
  // Import-mode exclusion Select buttons — *-multi types append to their
  // bound input instead of going through addPair (which is the queue path).
  bindSelector("selectImportExcludeServers", "importExcludeServers", "server-multi", "导入：排除服务器");
  bindSelector("selectImportExcludeChannels", "importExcludeChannels", "channel-multi", "导入：排除频道");
  bindSelector("selectImportExcludeUsers", "importExcludeUsers", "user", "导入：排除私信用户");
  // Live-search channel exclusion list — *-multi so captures append rather
  // than going through addPair (which would queue the channel as a target).
  bindSelector("selectExcludeChannel", "excludeChannelIds", "channel-multi", "排除频道（保留）");

  // Import-mode exclusion Add / Delete buttons — append/remove the currently-
  // viewed server / channel from the exclusion CSV. Mirror the General queue's
  // addGuild / delGuild / addChannel / delChannel pattern. @me is allowed for
  // Server here (unlike the General queue) — excluding it skips every DM.
  $("button#addImportExcludeServers").onclick = () => {
    const server = getGuildId();
    if (server) addToCsvField($("input#importExcludeServers"), "导入：排除服务器", server);
  };
  $("button#delImportExcludeServers").onclick = () => {
    const server = getGuildId();
    if (server) removeFromCsvField($("input#importExcludeServers"), "导入：排除服务器", server);
  };
  $("button#addImportExcludeChannels").onclick = () => {
    const channel = getChannelId();
    if (channel) addToCsvField($("input#importExcludeChannels"), "导入：排除频道", channel);
  };
  $("button#delImportExcludeChannels").onclick = () => {
    const channel = getChannelId();
    if (channel) removeFromCsvField($("input#importExcludeChannels"), "导入：排除频道", channel);
  };
  // Live-search channel exclusion list — Add / Delete act on the channel
  // you're currently viewing, same pattern as the import-mode equivalents.
  $("button#addExcludeChannel").onclick = () => {
    const channel = getChannelId();
    if (channel) addToCsvField($("input#excludeChannelIds"), "排除频道（保留）", channel);
  };
  $("button#delExcludeChannel").onclick = () => {
    const channel = getChannelId();
    if (channel) removeFromCsvField($("input#excludeChannelIds"), "排除频道（保留）", channel);
  };

  // Clear buttons inside each text input. Server clear cascades to Channel
  // (channels are scoped to a parent server). Channel clear leaves Server alone.
  bindClearButton("clearAuthor", "authorId", "作者 ID");
  bindClearButton("clearSearch", "search", "包含文本");
  bindClearButton("clearExcludeSearch", "excludeSearch", "跳过文本");
  bindClearButton("clearMentions", "mentionsId", "提及用户");
  bindClearButton("clearExcludeMentions", "excludeMentionsId", "跳过提及");
  bindClearButton("clearExcludeExtensions", "excludeExtensions", "跳过扩展名（自定义）");
  bindClearButton("clearMinId", "minId", "晚于此消息 ID");
  bindClearButton("clearMaxId", "maxId", "早于此消息 ID");
  bindClearButton("clearImportExcludeServers", "importExcludeServers", "导入：排除服务器");
  bindClearButton("clearImportExcludeChannels", "importExcludeChannels", "导入：排除频道");
  bindClearButton("clearImportExcludeUsers", "importExcludeUsers", "导入：排除私信用户");
  bindClearButton("clearExcludeChannelIds", "excludeChannelIds", "排除频道（保留）");
  // Server clear also clears Channel — Channel can't exist without its parent.
  $("button#clearGuild").onclick = () => {
    const g = $("input#guildId"), c = $("input#channelId");
    if (!g.value.trim() && !c.value.trim()) return log.info("服务器和频道字段已经为空。");
    g.value = "";
    c.value = "";
    log.info("已清空服务器和频道字段。");
    renderQueue();
  };
  // Channel clear leaves Server intact — except for @me, which gets dropped
  // (an @me entry with no DM channels is unrunnable).
  $("button#clearChannel").onclick = () => {
    const c = $("input#channelId");
    if (!c.value.trim()) return log.info("频道字段已经为空。");
    c.value = "";
    log.info("已清空频道字段。");
    renderQueue();
    cleanupOrphanedMe();
  };

  // Date interval shortcuts. 1 day / 1 week set min=now−Δ, max=now. "All"
  // resets After to Discord's epoch (visible lower bound) and clears Before.
  $("button#datePresetDay").onclick = () => setDateRange(1);
  $("button#datePresetWeek").onclick = () => setDateRange(7);
  $("button#datePresetAll").onclick = () => setDateRange(null);
  buildOneClickRow();

  // Live pre-2015 clamp on each date field — fires the moment the user commits a value.
  bindDateClamp("minDate", "起始日期");
  bindDateClamp("maxDate", "结束日期");

  // Streamer mode: drives two separate effects.
  //   1. CSS — toggling .streamer-on on the panel root dots out every ID-bearing
  //      input field (see the .streamer-on rules in styles.css). Text-content
  //      filter inputs stay readable.
  //   2. Run-time — the streamerMode option is read by core in promptConfirmation
  //      and the per-delete log line; both redact the message body and author.
  const syncStreamerClass = () => {
    ui.undiscordWindow.classList.toggle("streamer-on", $("input#streamerMode").checked);
  };
  $("input#streamerMode").addEventListener("change", syncStreamerClass);
  syncStreamerClass();

  // Help-button delegation: every <button class="help-btn" data-help="<key>">
  // routes to the matching HELP_TEXT entry. preventDefault stops the click
  // from triggering the parent <details> when the button is embedded in a <summary>.
  ui.undiscordWindow.addEventListener("click", e => {
    const btn = e.target.closest("button.help-btn");
    if (btn) {
      e.preventDefault();
      e.stopPropagation();
      showHelp(btn.dataset.help);
    }
  });

  // Mutually-exclusive checkbox pairs between Search filter and Delete filter
  // — checking one auto-unchecks its counterpart. Both checked at once would
  // always match nothing.
  for (const t of ["Link", "Image", "Video", "Sound", "Sticker", "Poll", "Embed", "Forward"]) {
    bindMutex(`has${t}`, `exclude${t}`);
  }
  bindMutex("mentionEveryone", "excludeMentionEveryone");

  // Skip Image / Skip Video category toggles cascade onto their preset
  // extension pills (and unchecking any child clears the parent).
  bindCascade("excludeImage", ["jpg", "png"]);
  bindCascade("excludeVideo", ["mp4", "webm"]);

  // Redirect log calls to the in-panel log area now that the DOM is ready.
  setLogFn(printLog);

  // Restore last session's settings after every binding above is in place —
  // applySnapshot re-runs renderQueue and the delay displays, and the footer
  // toggles re-sync via their change listeners, so the panel reflects the
  // restored values exactly as if the user had typed them.
  if (restoreSettings()) log.info("已自动恢复上次的任务设置（含排除频道、筛选与延迟）。");

  bindCoreEvents();

  // Persistence: whenever anything in the panel changes, save the whole form
  // (debounced). Bubble-phase on purpose — field-level handlers (date clamp,
  // stepper commit) fire first and finish mutating the value before the
  // bubbled event reaches this listener.
  let persistTimer = null;
  const schedulePersist = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(persistSettings, 400);
  };
  ui.undiscordWindow.addEventListener("input", schedulePersist);
  ui.undiscordWindow.addEventListener("change", schedulePersist);

  toggleWindowRef = toggleWindow;
  const dispose = () => {
    // A run in flight must die with the panel, or the engine keeps deleting
    // after the plugin is disabled / hot-reloaded.
    if (undiscordCore.state.running) undiscordCore.stop();
    if (persistTimer) clearTimeout(persistTimer);
    document.removeEventListener("keydown", keyHandler, true);
    window.removeEventListener("resize", fitToViewport);
    toggleWindowRef = null;
    ui.undiscordWindow?.remove();
    styleEl?.remove();
    ui.undiscordWindow = null;
    initUI.mounted = false;
    initUI.dispose = null;
  };
  initUI.mounted = true;
  initUI.dispose = dispose;
  return dispose;
}


// ============================================================================
// DATE INTERVAL HELPERS
// ----------------------------------------------------------------------------
// Discord's snowflake epoch (2015-01-01) is the lower bound on any valid
// message timestamp. Date inputs auto-clamp to [epoch, now] on commit.
// ============================================================================

const DISCORD_EPOCH_LOCAL = "2015-01-01T00:00";
const DISCORD_EPOCH_MS = new Date(DISCORD_EPOCH_LOCAL).getTime();

/** Formats a Date as the YYYY-MM-DDTHH:MM string that `<input type="datetime-local">` requires. */
function fmtLocal(d) {
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** On every committed change to a date input, snaps out-of-range values back into [Discord epoch, now] and emits a warning. Empty values and currently-invalid drafts are left alone. */
function bindDateClamp(inputId, fieldName) {
  const input = $(`input#${inputId}`);
  input.addEventListener("change", () => {
    const v = input.value.trim();
    if (!v) return;
    const ms = new Date(v).getTime();
    if (Number.isNaN(ms)) return;
    if (ms < DISCORD_EPOCH_MS) {
      input.value = DISCORD_EPOCH_LOCAL;
      log.warn(`“${fieldName}”早于 2015-01-01，已限制为 ${DISCORD_EPOCH_LOCAL}（Discord 在此日期前尚不存在）。`);
    } else if (ms > Date.now()) {
      const nowLocal = fmtLocal(new Date());
      input.value = nowLocal;
      log.warn(`“${fieldName}”位于未来，已限制为 ${nowLocal}（该时间点尚不存在消息）。`);
    }
  });
}

/** Sets the After/Before date inputs to "now − N days" through "now". Pass null for "all time" — After resets to Discord's epoch, Before clears (no upper bound). */
function setDateRange(days) {
  const minInput = $("input#minDate");
  const maxInput = $("input#maxDate");
  if (days === null) {
    minInput.value = DISCORD_EPOCH_LOCAL;
    maxInput.value = "";
    return;
  }
  const now = new Date();
  const past = new Date(now.getTime() - days * 86400000);
  minInput.value = fmtLocal(past);
  maxInput.value = fmtLocal(now);
}


// ============================================================================
// ONE-CLICK RECENT WIPE
// ----------------------------------------------------------------------------
// Preset row injected into the "Date interval" section at runtime (the upstream
// template stays untouched, so re-ports don't clobber it): author = me, target
// = the server currently open in Discord, window = preset dropdown or custom
// value+unit. Then it hands off to the normal startAction pipeline — the
// standard first-page confirmation still gates every actual deletion. The
// window selection persists across reloads under its own localStorage key.
// ============================================================================

const ONECLICK_KEY = "UndiscordLite-oneClickWindow";
const ONECLICK_WINDOWS = {
  "1h": 3600000,
  "6h": 21600000,
  "24h": 86400000,
  "3d": 259200000,
  "7d": 604800000,
  "30d": 2592000000,
};

function buildOneClickRow() {
  if (document.getElementById("oneClickWindow")) return; // idempotent across re-inits
  const details = $("button#datePresetAll")?.closest("details");
  if (!details) return;

  const wrap = document.createElement("fieldset");
  wrap.innerHTML = `
    <legend>一键清理 · 我自己的近期消息</legend>
    <div class="input-wrapper">
      <select id="oneClickWindow" title="清理自己在本服务器近期消息的时间窗口">
        <option value="1h">近 1 小时</option>
        <option value="6h">近 6 小时</option>
        <option value="24h">近 24 小时</option>
        <option value="3d">近 3 天</option>
        <option value="7d">近 7 天</option>
        <option value="30d">近 30 天</option>
        <option value="custom">自定义…</option>
      </select>
      <input id="oneClickCustomVal" type="number" min="1" max="999" step="1" value="24" title="自定义时长" style="display:none">
      <select id="oneClickCustomUnit" style="display:none">
        <option value="m">分钟</option>
        <option value="h">小时</option>
        <option value="d">天</option>
      </select>
    </div>
    <div class="input-actions">
      <button id="oneClickWipe" title="作者=自己 + 当前服务器全频道 + 所选时间窗，随后进入正常的搜索→确认→删除流程">清除我在本服务器的近期消息</button>
    </div>`;
  details.appendChild(wrap);

  const sel = $("select#oneClickWindow");
  const cv = $("input#oneClickCustomVal");
  const cu = $("select#oneClickCustomUnit");

  // Restore the last picked window before wiring, so the panel shows it.
  try {
    const saved = JSON.parse(readLocalStorage(ONECLICK_KEY) || "null");
    if (saved && (saved.win === "custom" || ONECLICK_WINDOWS[saved.win])) {
      sel.value = saved.win;
      if (Number.isFinite(saved.val) && saved.val >= 1) cv.value = String(saved.val);
      if (["m", "h", "d"].includes(saved.unit)) cu.value = saved.unit;
    }
  } catch { /* corrupt save — fall back to defaults */ }

  const syncCustom = () => {
    const show = sel.value === "custom" ? "" : "none";
    cv.style.display = show;
    cu.style.display = show;
  };
  const save = () => writeLocalStorage(ONECLICK_KEY, JSON.stringify({ win: sel.value, val: cv.value, unit: cu.value }));
  sel.addEventListener("change", () => { syncCustom(); save(); });
  cv.addEventListener("change", save);
  cu.addEventListener("change", save);
  syncCustom();

  $("button#oneClickWipe").onclick = oneClickWipe;
}

/** Milliseconds for the currently selected window; null (with a log line) when the custom value is invalid. */
function oneClickWindowMs() {
  const win = $("select#oneClickWindow").value;
  if (win !== "custom") return ONECLICK_WINDOWS[win] ?? 86400000;
  const val = Number($("input#oneClickCustomVal").value);
  if (!Number.isFinite(val) || val < 1) {
    log.warn("自定义时长无效——请填写不小于 1 的整数。");
    return null;
  }
  const unit = $("select#oneClickCustomUnit").value;
  return val * (unit === "m" ? 60000 : unit === "h" ? 3600000 : 86400000);
}

/** Human label for the log line; custom windows get composed "近 N 单位" text. */
function oneClickWindowLabel() {
  const sel = $("select#oneClickWindow");
  if (sel.value !== "custom") return sel.options[sel.selectedIndex].text;
  const unitZh = { m: "分钟", h: "小时", d: "天" }[$("select#oneClickCustomUnit").value];
  return `近 ${$("input#oneClickCustomVal").value} ${unitZh}`;
}

async function oneClickWipe() {
  if (undiscordCore.state.running) return log.warn("已有任务在运行。");
  const ms = oneClickWindowMs();
  if (!ms) return;
  const selfId = getAuthorId();
  if (!selfId) return log.error("无法读取自己的用户 ID——一键清理不可用。");
  const server = getGuildId();
  if (!server || server === "@me") return log.warn("一键清理只能在服务器频道内使用——请先切到目标服务器的任意频道再打开面板。");

  if (selectionQueue.length)
    log.warn(`注意：批次队列里还有 ${selectionQueue.length} 个选择，本次会先依次运行它们（不想跑可先点「丢弃批次」）。`);

  // Clear every filter first so the semantics are truly "ALL my messages in the window".
  resetAllSelection();
  $("input#authorId").value = selfId;
  addPair(server, "");
  const now = new Date();
  $("input#minDate").value = fmtLocal(new Date(now.getTime() - ms));
  $("input#maxDate").value = fmtLocal(now);
  persistSettings();

  log.info(`一键清理已配置：服务器=${dot(server)}，作者=自己，窗口=${oneClickWindowLabel()}。按正常流程开始，删除前仍会要求确认。`);
  // The window has to sit in the visible date fields for the run to use it. But
  // leaving it there afterwards means the next plain search silently inherits a
  // one-hour bound and reports nothing — which reads as "search is broken". The
  // window is this button's own doing, so the button undoes it: once the run is
  // over (declined or stopped included, since the bound was never the user's
  // choice) the filter goes back to all time.
  const appliedMin = $("input#minDate").value;
  const appliedMax = $("input#maxDate").value;
  log.info(`本次运行使用日期窗口 ${appliedMin} → ${appliedMax}，结束后自动恢复为「全部时间」。`);
  for (const id of ["minDate", "maxDate"]) {
    const el = $(`input#${id}`);
    if (!el) continue;
    const prev = el.style.boxShadow;
    el.style.boxShadow = "0 0 0 2px var(--brand-experiment, #5865f2)";
    setTimeout(() => { el.style.boxShadow = prev; }, 2500);
  }
  try {
    await startAction();
  } finally {
    // A long run leaves the form reachable, and a batch run replays its queued
    // snapshots through the same fields, so only undo our own write: if the dates
    // no longer hold what we set, something else owns them now.
    if ($("input#minDate").value === appliedMin && $("input#maxDate").value === appliedMax) {
      setDateRange(null);
      persistSettings();
      log.info("日期筛选已恢复为「全部时间」。");
    } else {
      log.info("日期筛选保持原样未自动恢复（运行结束后表单里已不是本次写入的那一组日期）。");
    }
  }
}


// ============================================================================
// HELP-BUTTON REGISTRY
// ----------------------------------------------------------------------------
// Each key maps to a { name, lines } entry printed into the log when a [Help]
// button with the matching `data-help=<key>` attribute is clicked. HTML is
// preserved in lines (so <i>/<b>/<code> work); use &lt;/&gt; for literal angle
// brackets and &nbsp; for indentation.
//
// To add help for a new section:
//   1. Add a key + { name, lines: [...] } entry below.
//   2. Add a <button class="help-btn" data-help="<key>">Help</button> as a
//      sibling of the relevant <legend> in undiscord.html.
// ============================================================================

const HELP_TEXT = {
  tabGeneral: {
    name: "General",
    lines: [
      "Defines <i>who</i> is being deleted (Author ID), <i>where</i> (Server / Channel / DMs), and builds the queue for batch wipes.",
      "Each fieldset has its own <b>[Help]</b> button for detailed instructions on that field.",
      "Multiple servers and channels can be queued — the run processes them sequentially as one batch.",
      "Use <b>Exclude Channel</b> to spare specific channels (or threads) while wiping everything else in a server.",
      "Settings persist across reloads — the panel restores whatever was set last session (targets, Exclude Channel, filters, delays, footer toggles). <b>Reset Selection</b> clears them.",
    ],
  },
  tabSearchFilter: {
    name: "Search filter",
    lines: [
      "Narrows what Discord's search API returns before the script considers anything for deletion. Server-side filters are faster than client-side ones.",
      "Three groups: <b>Include text</b>, <b>Include attachment type</b>, <b>Include @user</b>. Each has its own [Help] for details.",
      "Anything Discord returns can still be excluded post-search via the <b>Delete filter</b> section.",
    ],
  },
  tabDeleteFilter: {
    name: "Delete filter",
    lines: [
      "Drops messages from the deletion list <i>after</i> Discord's search returns them. Same three-group shape as the Search filter — text, attachment types, @user.",
      "Each Search/Delete attachment-type pair is mutually exclusive — checking one auto-unchecks the other (both checked at once would always match nothing).",
      "Useful when Discord's tokenized search can't express what you want — e.g. \"delete everything <i>except</i> messages mentioning Alice.\"",
    ],
  },
  tabMessagesInterval: {
    name: "Messages interval",
    lines: [
      "Bound the wipe to a snowflake range using two message IDs.",
      "Right-click any message → <b>Copy Message Link</b>, paste into either field. The script <b>auto-strips the URL</b> down to just the trailing message ID — no manual cleanup needed. Pasting a bare snowflake also works directly.",
      "<b>Messages interval overrides Date interval</b> if both are set.",
    ],
  },
  tabDateInterval: {
    name: "Date interval",
    lines: [
      "Bound the wipe by date. Use the date pickers, or click <b>1 Day</b> / <b>1 Week</b> / <b>All</b> for convenience presets.",
      "Pre-2015 and future dates auto-clamp on input with a warning. After defaults to Discord's launch (2015-01-01).",
      "Ignored if <b>Messages interval</b> is also set.",
    ],
  },
  tabAdvanced: {
    name: "Delay settings",
    lines: [
      "Tune the per-page wait (<b>Search delay</b>) and per-delete pause (<b>Delete delay</b>).",
      "Both auto-bump on Discord's 429 rate-limit responses, then decay back toward your stepper value as subsequent requests succeed.",
      "Defaults (45000 ms search / 1000 ms delete) are tuned to never trigger 429s. Lower at your own risk.",
    ],
  },
  authorId: {
    name: "Author ID",
    lines: [
      "The UserID of the person whose messages you want to delete.",
      "Leave it <b>empty</b> to delete messages from <b>everyone</b> in range — no author filter is applied. This needs <i>Manage Messages</i> on the target channel / 子区, and the pre-flight verifies it before the run starts.",
      "Click <b>Me</b> to autofill your own UserID.",
      "You <i>can</i> delete others' messages if you have <i>Manage Messages</i> permission over them — e.g. you're an admin in a server you own, or have mod perms in.",
      "To copy someone else's UserID from a chat:",
      "&nbsp;&nbsp;1. Enable Developer Mode (Discord settings &rarr; Advanced).",
      "&nbsp;&nbsp;2. Right-click their profile icon &rarr; <b>Copy User ID</b>.",
      "&nbsp;&nbsp;3. Right-click a message &rarr; <b>Copy Message ID</b> (also useful for Messages interval).",
      "To chain multiple people, comma-separate the IDs: <code>id1,id2,id3</code>. The run expands to one job per (target × author).",
      "<b>Auto-format on paste:</b> pasting one snowflake-shaped ID, or a comma-separated list of them, appends to the current value with deduplication — no need to manually edit the existing text. Pastes that aren't snowflake-shaped fall through to native paste so you can correct typos.",
      "Click <b>Select</b> to enter point-and-click capture mode, then click any user / avatar / message author in Discord to capture their User ID — hold Shift to capture several in a row.",
      "Non-self authors (and an empty field = everyone) require <i>Manage Messages</i>. A pre-flight check runs at the top of the batch — per channel / 子区 for specific targets, falling back per server — and aborts early if any target lacks it.",
      "DMs are excluded from multi-author batching — Discord only lets you delete your own DM messages, so each DM target spawns one self-author job regardless of how many IDs are in the list.",
      "<b>Exclude NSFW channels</b> checkbox (default off): when checked, age-gated channels return zero results from Discord's search API. Default behavior is to include them.",
    ],
  },
  serverId: {
    name: "Server ID",
    lines: [
      "The Discord Server (Guild) where messages should be deleted.",
      "Click <b>Add</b> while viewing a server to queue it (server-wide wipe — current Server ID is read from Discord's URL).",
      "Click <b>Select</b> to enter point-and-click capture mode, then click any server icon in Discord to queue it. Hold Shift to capture several in a row.",
      "Click <b>Delete</b> to remove the current server from the queue.",
      "Multiple servers can be queued — the run processes them sequentially as one batch.",
      "An empty <b>Channel ID</b> with this set means <i>wipe the entire server</i> (every channel you have access to).",
      "Right-click a server icon &rarr; <b>Copy Server ID</b> (Developer Mode required).",
    ],
  },
  channelId: {
    name: "Channel ID",
    lines: [
      "Restrict the wipe to a specific channel inside the queued server.",
      "Click <b>Add</b> while inside a channel to queue (currentServer, currentChannel) — both are read from Discord's URL.",
      "Click <b>Select</b> to enter point-and-click capture mode, then click any channel (or any message inside one) in Discord. Hold Shift to capture several in a row.",
      "Click <b>Delete</b> to remove the current channel from the queue. Removing the last channel under a server widens it back to a server-wide wipe.",
      "Leave empty (with a Server ID set) to target the whole server.",
      "Right-click a channel name &rarr; <b>Copy Channel ID</b> (Developer Mode required).",
    ],
  },
  excludeChannel: {
    name: "Exclude Channel (Keep)",
    lines: [
      "The <i>keep</i> list: channels a server-wide wipe must <b>never</b> touch.",
      "Set the Server ID and leave Channel ID empty for a whole-server wipe, then list the channels to preserve here. Messages from listed channels are dropped client-side after Discord's search returns them, so the run continues past them.",
      "Click <b>Add</b> while inside a channel to add it, <b>Delete</b> to remove it, or <b>Select</b> then click a channel (or any message inside one) in Discord — hold Shift to capture several in a row. Comma-separated IDs pasted into the field append with dedup.",
      "Threads are separate channels in Discord's search results — paste a thread's ID here to spare just that thread, or list its parent channel to spare the whole channel.",
      "This list applies in <b>import mode</b> as well, merged with the import-only Exclude Channel list.",
      "Threads that Discord refuses to delete because they are archived are skipped automatically during a run (one failed request per thread, not per message) — you don't need to list them here.",
    ],
  },
  dms: {
    name: "DMs",
    lines: [
      "Click <b>Add DMs</b> to queue every DM channel currently open in your sidebar — both 1:1 and group DMs by default. Check <b>Exclude group DMs</b> to leave group DMs out of the bulk add.",
      "Click <b>Clear DMs</b> to remove every queued DM at once.",
      "DMs you've X'd out of the sidebar aren't returned by Discord's API — re-open them in Discord first if you need them included.",
      "Uses Discord's <code>GET /users/@me/channels</code> endpoint with your existing auth token.",
    ],
  },
  includeText: {
    name: "Include text",
    lines: [
      "Only search for messages whose content contains this text.",
      "Discord's search is <i>tokenized</i> and case-insensitive: <b>cat</b> matches messages with the word <i>cat</i> but not <i>catdog</i> or <i>category</i>.",
      "Leave empty to match any text content.",
    ],
  },
  includeAttachment: {
    name: "Include attachment type",
    lines: [
      "Restrict the search to messages that include the toggled type(s): Link, Image, Video, Sound, Sticker, Poll, Embed, Forward.",
      "Multiple toggles are <b>AND-combined</b> by Discord — checking Image AND Video returns messages with <i>both</i>, not either. Most users want to check one at a time.",
      "<b>Pinned</b>: choose <i>exclude</i> (skip pinned), <i>include</i> (delete pinned alongside others), or <i>only pinned</i> (target pinned only).",
    ],
  },
  includeUser: {
    name: "Include @user",
    lines: [
      "Restrict the search to messages where this user is @mentioned.",
      "<b>Single user only</b> — Discord's search API can only filter by one mentioned user per request, so this field accepts exactly one ID. Pasting or capturing a new ID overwrites the current value.",
      "<b>Auto-format on paste:</b> pasting a snowflake-shaped ID overwrites the field directly. Non-snowflake clipboards fall through to native paste so you can edit freely.",
      "If you need to match several mentioned users, run separate passes (one per ID). The asymmetry only affects this side — see <b>Skip @user</b> for the multi-value variant.",
      "Toggle <b>has @everyone / @here</b> to also include messages that pinged everyone or online users.",
      "Right-click a user &rarr; <b>Copy User ID</b> (Developer Mode required), or use <b>Select</b> and click any avatar/username in the message list.",
      "Leave the field empty to ignore mentions when matching.",
    ],
  },
  excludeText: {
    name: "Skip text",
    lines: [
      "Skip messages whose content matches this text — they survive the run.",
      "<b>Match: Substring</b> — term appears anywhere (<i>cat</i> skips <i>I love my cat</i> AND <i>I love cats</i>).",
      "<b>Match: Exact</b> — term must appear as a standalone word (<i>cat</i> skips <i>I love my cat</i> but NOT <i>I love cats</i>).",
      "Applied client-side after the search response — works in combination with the include side.",
    ],
  },
  excludeAttachment: {
    name: "Skip attachment type",
    lines: [
      "Skip messages that include the toggled type(s) — they survive the run.",
      "Mutually exclusive with the matching toggle in <b>Include attachment type</b>: checking one here automatically un-checks its counterpart on the search side, since both checked at once would always match nothing.",
      "Applied client-side after the search response.",
    ],
  },
  excludeExtension: {
    name: "Skip extension",
    lines: [
      "Skip messages whose attachments include any file with one of the listed extensions.",
      "<b>Quick toggles</b> — the 8 preset pills cover the most-shared file types on Discord: .jpg, .png, .mp4, .webm, .pdf, .docx, .txt, .zip. Toggle any green to skip messages with attachments of that type.",
      "<b>Custom extensions</b> — for anything not in the presets, enter a semicolon-separated list (with or without leading dots), e.g. <code>.psd;.dmg;.iso</code>. Whitespace is trimmed; case is normalized; dots are optional.",
      "<b>How matching works</b> — for each attachment on a message, the file extension is taken from its filename (live search) or its URL (import mode), lowercased, and checked against the merged set of presets + custom. Any single attachment match drops the whole message.",
      "Applied client-side after the search response (or as part of the import-mode pre-pass) — works alongside the other Skip toggles.",
      "Asymmetric on purpose — there is no Include-extension counterpart on the Search filter side, since Discord's search API only filters by attachment <i>category</i> (image / video / sound / etc.) and not specific extensions.",
    ],
  },
  excludeUser: {
    name: "Skip @user",
    lines: [
      "Skip messages where any of these users are @mentioned — they survive the run.",
      "<b>Multi-value</b> — comma-separate any number of user IDs, or paste/capture them one at a time and they'll append (with dedup). Every listed ID is checked against each message's mentions at filter time, so all of them work in a single pass — unlike <b>Include @user</b>, this side has no API limit because it's a client-side check after the search response.",
      "<b>Auto-format on paste:</b> pasting a single snowflake-shaped ID, or a comma-separated list, appends to the current value with deduplication. Non-snowflake clipboards fall through to native paste.",
      "Toggle <b>skip @everyone / @here</b> to also skip messages that pinged everyone or online users.",
      "Right-click a user &rarr; <b>Copy User ID</b> (Developer Mode required), or use <b>Select</b> and click avatars/usernames; hold Shift to capture several in a row.",
      "An ID listed here cannot also be in <b>Include @user</b> — that combination would always match nothing.",
    ],
  },
  messagesInterval: {
    name: "Messages interval",
    lines: [
      "Bound the search to messages between two specific message IDs (Discord snowflakes).",
      "<b>Auto-format on paste:</b> right-click a message &rarr; <b>Copy Message Link</b>, then paste into either field — the script auto-strips the URL down to just the trailing message ID. Pasting a bare snowflake also works directly. Non-link clipboards fall through to native paste.",
      "Click <b>Select</b> next to either field to enter point-and-click capture mode, then click any message in Discord to capture its ID.",
      "<b>After ID</b> must be older (smaller snowflake) than <b>Before ID</b>.",
      "If only one bound is set, the other is unbounded (channel start or current time).",
      "<b>Messages interval overrides Date interval</b> if both are set.",
    ],
  },
  dateInterval: {
    name: "Date interval",
    lines: [
      "Bound the search to messages posted between two dates.",
      "Use the datetime pickers, or click <b>1 Day</b> / <b>1 Week</b> / <b>All</b> for convenience presets.",
      "<b>After date</b> defaults to Discord's launch (2015-01-01) so the lower bound is always explicit.",
      "Both fields auto-clamp to <code>[2015-01-01, now]</code> on input — out-of-range values snap and log a warning.",
      "If only one bound is set, the other is unbounded.",
      "<b>Date interval is ignored</b> if Messages interval is also set.",
    ],
  },
  searchDelay: {
    name: "Search delay",
    lines: [
      "Time the script waits between fetching pages of messages from Discord's search API.",
      "Range <b>15000–60000 ms</b>, default <b>45000 ms</b> (45s).",
      "Lower = faster but more 429 rate-limit hits. Discord throttles search aggressively below ~30s.",
      "On a 429, the effective delay auto-bumps to whatever Discord asks for, then decays back toward your stepper value as subsequent requests succeed (half-life decay).",
      "Click <b>↺</b> to reset to default.",
    ],
  },
  deleteDelay: {
    name: "Delete delay",
    lines: [
      "Pause between individual delete API calls.",
      "Range <b>100–3000 ms</b>, default <b>1000 ms</b> (1s).",
      "Lower = faster, but more risk of mid-run rate-limiting.",
      "Same auto-bump and half-life-decay behavior as Search delay.",
      "Click <b>↺</b> to reset to default.",
    ],
  },
  importFolder: {
    name: "Import folder",
    lines: [
      "<b>What to pick:</b> the <code>messages/</code> folder inside your unzipped Discord data export — the folder that contains the per-channel <code>c&lt;ID&gt;/</code> subfolders and the top-level <code>index.json</code>. Pick the parent folder, NOT a single channel folder.",
      "<b>Click <b>Select Folder...</b></b> to open the OS folder picker. Your browser will warn that the site is about to read every file in the folder — that's the standard <code>webkitdirectory</code> consent prompt; nothing is uploaded, files are read locally via the browser's File API.",
      "<b>After selection</b>: the parser walks every <code>c&lt;ID&gt;/messages.json</code> in the tree, reads the per-channel <code>channel.json</code> for guild / DM metadata, then prints a summary line plus a per-source breakdown into the log. The status line above the log flips to <i>import mode</i>.",
      "<b>Click <b>Clear Import</b></b> to drop the loaded set from memory and return to live-search mode. Picking a different folder afterwards loads it fresh — there's no need to clear first if you just want to swap exports.",
      "<b>If your browser doesn't support folder picking</b> (rare on desktop): the picker has <code>multiple</code> too, so Ctrl+A inside the unzipped <code>messages/</code> folder and pick all files as a flat batch. The parser groups them by parent folder name, so the result is identical.",
      "<b>Picking the wrong folder</b> (e.g. the top-level export folder instead of <code>messages/</code>) errors out with \"No c&lt;channelId&gt;/ folders found.\" — the parser refuses to half-import.",
    ],
  },
  importExport: {
    name: "Import data export",
    lines: [
      "Pre-load message IDs from your Discord data export and skip the search phase entirely. Roughly <b>3-5x faster</b> than search-mode on large wipes, with no risk of \"search index lag\" empty-page failures.",
      "<b>How to get an export:</b> Discord settings &rarr; Privacy &amp; Safety &rarr; <b>Request All My Data</b>. Discord emails you a ZIP after a few minutes (sometimes a few days). Unzip it locally — inside is a <code>messages/</code> folder.",
      "<b>How to use it:</b> Click <b>Select Folder...</b> and pick that <code>messages/</code> folder. The summary line fills in (total messages, channel count, oldest/newest date). Set Date or Messages interval if you want to bound the wipe. Click <b>▶︎ Delete</b>.",
      "<b>What still applies:</b> Date interval, Messages interval, Delete delay, Streamer mode, plus the Skip filters that have data to operate on — Skip text, Skip Link, Skip Image, Skip Video, Skip Sound, Skip extension (presets + custom), Skip @user, Skip @everyone/@here. All applied as a client-side pre-pass before the delete loop starts. Mention skips work because Discord's export stores user mentions inline in the content as <code>&lt;@USERID&gt;</code> and the literal <code>@everyone</code>/<code>@here</code> text. Extension matching uses the URL since the export doesn't carry filenames.",
      "<b>What doesn't apply:</b> Author / Server / Channel / DMs queue, Search filter, and the Skip filters that need metadata the export doesn't carry — Skip Sticker, Skip Poll, Skip Embed, Skip Forward. Those individual toggles grey out when an import is loaded; if any are checked from before, a warning lists them at run start.",
      "<b>Edge cases:</b> Already-deleted messages return 404 (counted as failed but harmless). Channels you've lost access to (banned, deleted, etc) return 403 (same).",
      "<b>Privacy:</b> the export is parsed in-browser. Nothing is uploaded — there is no code path that sends imported data anywhere. The export contains every DM you've ever had; don't commit <code>messages/</code> to a git repo (the bundled <code>.gitignore</code> covers this).",
      "Click <b>Clear Import</b> to drop the loaded set and return to live-search mode.",
    ],
  },
  importExcludeServer: {
    name: "Import — Exclude Server",
    lines: [
      "Drop entire <b>servers</b> from the import before the delete loop runs. Comma-separate any number of Server IDs.",
      "Click <b>Select</b> and then click a server icon in Discord to capture its ID — hold Shift to capture several in a row.",
      "<b>Auto-format on paste:</b> pasting one snowflake-shaped ID, or a comma-separated list, appends to the current value with deduplication. Non-snowflake clipboards fall through to native paste.",
      "Matches against each message's <code>guildId</code> as recorded in <code>channel.json</code>. <b>Use <code>@me</code></b> to drop every DM and group DM in one go (they all carry <code>guildId=@me</code>).",
      "For a wildcard \"drop every server\" pass, see the <b>Exclude servers</b> pill above the selector fields — the convenience equivalent of listing every server ID here.",
      "Servers in the export but not currently joined still match — the filter is purely client-side against the export data.",
    ],
  },
  importExcludeChannel: {
    name: "Import — Exclude Channel",
    lines: [
      "Drop specific <b>channels</b> from the import. Comma-separate any number of channel IDs (works for guild channels, DMs, and group DMs alike — they all use the same snowflake format).",
      "Click <b>Select</b> and then click a channel in the sidebar (or any message inside one) to capture its ID — hold Shift to capture several in a row.",
      "<b>Auto-format on paste:</b> pasting one snowflake-shaped ID, or a comma-separated list, appends with deduplication. Non-snowflake clipboards fall through to native paste.",
      "Matches against each message's <code>channelId</code>. Independent of <b>Exclude Server</b> — a channel listed here is dropped even if its parent server isn't excluded.",
      "For a wildcard \"drop every group DM\" pass, see the <b>Exclude group DMs</b> pill above the selector fields.",
    ],
  },
  importExcludeUser: {
    name: "Import — Exclude DM with User",
    lines: [
      "Drop <b>DMs</b> and <b>group DMs</b> that include the listed user(s) as participants. Comma-separate any number of User IDs.",
      "Click <b>Select</b> and then click an avatar / username / message author in Discord to capture the User ID — hold Shift to capture several in a row.",
      "<b>Auto-format on paste:</b> pasting one snowflake-shaped ID, or a comma-separated list, appends with deduplication. Non-snowflake clipboards fall through to native paste.",
      "Matches against the channel's <code>recipients</code> list (from <code>channel.json</code>). For group DMs, any single matched recipient drops the whole group.",
      "For a wildcard \"drop every 1:1 DM\" pass, see the <b>Exclude DMs</b> pill above the selector fields.",
      "<b>Guild messages are unaffected by design</b> — every message in your own data export was sent <i>by</i> you, so there's no other-author dimension to filter on. Use <b>Exclude Channel</b> if you want to spare specific guild channels.",
    ],
  },
};

/** Looks up a HELP_TEXT entry by key and prints its lines into the log. No-op when the key is unknown. */
function showHelp(key) {
  const entry = HELP_TEXT[key];
  if (!entry) return;
  log.info(`── ${entry.name.toUpperCase()} ──`);
  for (const line of entry.lines) log.info(`› ${line}`);
}


// ============================================================================
// CHECKBOX BINDERS
// ----------------------------------------------------------------------------
// Bidirectional couplings between checkboxes — mutex (one-or-the-other) and
// cascade (parent-with-children).
// ============================================================================

/** Mutex pair — checking one checkbox silently unchecks the other. Used between Search-filter and Delete-filter pairs where both checked at once would always match nothing. */
function bindMutex(idA, idB) {
  const a = $(`input#${idA}`);
  const b = $(`input#${idB}`);
  a.addEventListener("change", () => { if (a.checked && b.checked) b.checked = false; });
  b.addEventListener("change", () => { if (a.checked && b.checked) a.checked = false; });
}

/**
 * Couples a category-level Skip toggle (e.g. excludeImage) with its preset
 * extension pills (e.g. .jpg, .png). Two-way:
 *   - Parent toggled ON  → all children forced ON (cascade down).
 *   - Parent toggled OFF → all children forced OFF (cleanup).
 *   - Any child unchecked → parent unchecked (the "skip ALL of this category"
 *     claim is no longer true once a child is excluded).
 *   - Child checked alone → parent left untouched.
 */
function bindCascade(parentId, childExts) {
  const parent = $(`input#${parentId}`);
  const children = childExts.map(ext => ui.undiscordWindow.querySelector(`input[data-ext="${ext}"]`));
  parent.addEventListener("change", () => {
    for (const c of children) c.checked = parent.checked;
  });
  for (const c of children) {
    c.addEventListener("change", () => {
      if (!c.checked && parent.checked) parent.checked = false;
    });
  }
}


// ============================================================================
// DELAY STEPPERS
// ----------------------------------------------------------------------------
// Spinner-style controls for the search/delete delays. Display value is the
// raw integer ms; the unit suffix lives in the legend "(ms)" instead.
// ============================================================================

const SEARCH_MIN = 15000, SEARCH_MAX = 60000, SEARCH_STEP = 500, SEARCH_DEFAULT = 45000;
const DELETE_MIN = 100, DELETE_MAX = 3000, DELETE_STEP = 50, DELETE_DEFAULT = 1000;

/** Writes `ms` into the stepper input's display and `dataset.ms` mirror. */
function setDelayDisplay(inputId, ms) {
  const input = $(`input#${inputId}`);
  input.dataset.ms = ms;
  input.value = String(ms);
}

/** Returns the stepper input's current ms value as an integer. */
function getDelayMs(inputId) {
  return parseInt($(`input#${inputId}`).dataset.ms);
}

/** Reads every "Skip extension" toggle (preset pills carry data-ext) plus any custom extensions typed into #excludeExtensions (semicolon-separated, dots optional). Returns a deduplicated lowercase array of bare extensions; empty array means "no extension filter active". */
function readSkipExtensions() {
  const presets = Array.from(ui.undiscordWindow.querySelectorAll("input[data-ext]:checked"))
    .map(el => el.dataset.ext.toLowerCase());
  const customRaw = $("input#excludeExtensions").value.trim();
  const custom = customRaw
    ? customRaw.split(/\s*;\s*/).map(s => s.replace(/^\./, "").toLowerCase()).filter(Boolean)
    : [];
  return [...new Set([...presets, ...custom])];
}

/** Wires up the down/up/reset buttons and direct-typing handler for one stepper input. Apply clamps to [min, max]; out-of-range typed values revert to the previous good value with a warning. */
function bindStepper(inputId, min, max, step, defaultMs, stateKey) {
  const apply = next => {
    next = Math.max(min, Math.min(max, next));
    setDelayDisplay(inputId, next);
    undiscordCore.options[inputId] = next;
    undiscordCore.state[stateKey] = next;
  };
  $(`button#${inputId}Down`).onclick = () => apply(getDelayMs(inputId) - step);
  $(`button#${inputId}Up`).onclick = () => apply(getDelayMs(inputId) + step);
  $(`button#${inputId}Reset`).onclick = () => apply(defaultMs);

  // Direct typing — parse the digits, clamp to [min, max], apply. Strips any
  // non-numeric characters so the user can edit the displayed string in place.
  // Fires on blur or Enter.
  const input = $(`input#${inputId}`);
  input.addEventListener("change", () => {
    const raw = input.value.replace(/[^\d.]/g, "");
    const parsed = parseFloat(raw);
    if (Number.isNaN(parsed)) {
      setDelayDisplay(inputId, getDelayMs(inputId)); // revert to last good value
      log.warn("延迟值无效，已恢复原值。");
      return;
    }
    const rounded = Math.round(parsed);
    const clamped = Math.max(min, Math.min(max, rounded));
    if (clamped !== rounded) {
      log.info(`${inputId === "searchDelay" ? "搜索延迟" : "删除延迟"} 已从 ${rounded} 毫秒限制为 ${clamped} 毫秒（范围 ${min}–${max}）。`);
    }
    apply(clamped);
  });
  // Enter commits the edit and blurs (browsers fire change on blur after edit).
  input.addEventListener("keydown", e => { if (e.key === "Enter") input.blur(); });
}


// ============================================================================
// MESSAGE LINK AUTO-STRIP
// ----------------------------------------------------------------------------
// Pasting a Discord message link into a message-ID input replaces the pasted
// content with just the trailing message ID. Other clipboards paste normally.
// ============================================================================

/** Binds a paste handler that turns a pasted Discord message link into just the trailing message ID. Falls through to native paste when the clipboard isn't a message link. */
function bindLinkStrip(input) {
  input.addEventListener("paste", e => {
    const text = ((e.clipboardData || window.clipboardData).getData("text") || "").trim();
    const m = text.match(/^https?:\/\/(?:[\w.-]+\.)?discord\.com\/channels\/[\w@]+\/\d+\/(\d{15,25})\/?$/);
    if (m) {
      e.preventDefault();
      input.value = m[1];
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
}


// ============================================================================
// POINT-AND-CLICK ID CAPTURE (SELECTION MODE)
// ----------------------------------------------------------------------------
// A Select button arms a global capture-phase click listener; the next click
// on a Discord user / avatar / message / server icon / channel extracts the
// matching ID and inserts it into the bound input. Hold Shift to capture
// several in a row. Esc cancels. Auto-cancels after 60 s of inactivity.
//
// Type system:
//   user            — multi-value user IDs (comma-append, dedup)
//   user-single     — single user ID (overwrite)
//   server          — server ID, routed through addPair() into the queue
//   server-multi    — server ID appended to a multi-value text input
//   channel         — channel ID + parent server, routed through addPair()
//   channel-multi   — channel ID appended to a multi-value text input
//   message         — single message ID (overwrite)
// ============================================================================

let selection = null;
let selectionTimeout = null;
const SELECTION_TIMEOUT_MS = 60000;

/** Walks up from the click target to find a Discord message wrapper, then extracts the message ID from its `id="chat-messages-CHANNEL-MESSAGE"` attribute. */
function extractMessageId(elem) {
  const wrapper = elem.closest && elem.closest('[id^="chat-messages-"]');
  const m = wrapper && wrapper.id.match(/chat-messages-\d+-(\d+)/);
  return m ? m[1] : null;
}

/** Extracts a server (guild) ID. Tries the server-list `data-list-item-id="guildsnav___<ID>"` attribute first, then falls back to the URL of the currently-viewed server (resolves to "@me" on the friends tab). */
function extractServerId(elem) {
  const item = elem.closest && elem.closest('[data-list-item-id^="guildsnav___"]');
  if (item) {
    const m = item.getAttribute("data-list-item-id").match(/guildsnav___(\d+)/);
    if (m) return m[1];
  }
  // [\w@] so DM URLs like /channels/@me/<id> resolve to "@me", and the channel
  // segment is optional so the friends-tab URL /channels/@me matches too.
  const urlMatch = location.href.match(/channels\/([\w@]+)(?:\/\d+)?/);
  return urlMatch ? urlMatch[1] : null;
}

/**
 * Extracts a channel ID. Tries (in order):
 *   1. a server-channel sidebar item's data-list-item-id attribute
 *   2. a wrapping anchor whose href points at /channels/@me/<id> — DM list items
 *   3. the chat-messages wrapper of an open message in the active channel
 *   4. the URL of the currently-viewed channel
 */
function extractChannelId(elem) {
  const item = elem.closest && elem.closest('[data-list-item-id^="channels___"]');
  if (item) {
    const m = item.getAttribute("data-list-item-id").match(/channels___(\d+)/);
    if (m) return m[1];
  }
  // DM sidebar item: anchor href is the most stable identifier across Discord
  // versions (data-list-item-id naming for DMs has churned more than href has).
  const dmLink = elem.closest && elem.closest('[href*="/channels/@me/"]');
  if (dmLink) {
    const m = (dmLink.getAttribute("href") || "").match(/\/channels\/@me\/(\d+)/);
    if (m) return m[1];
  }
  const msg = elem.closest && elem.closest('[id^="chat-messages-"]');
  if (msg) {
    const m = msg.id.match(/chat-messages-(\d+)-\d+/);
    if (m) return m[1];
  }
  // [\w@] (not just \w) so DM URLs like /channels/@me/<id> still match here.
  const urlMatch = location.href.match(/channels\/[\w@]+\/(\d+)/);
  return urlMatch ? urlMatch[1] : null;
}

/**
 * Pulls the user ID out of any Discord CDN URL form:
 *   - Global avatar : cdn.discordapp.com/avatars/<UID>/<HASH>.<ext>
 *   - Per-server    : cdn.discordapp.com/guilds/<GID>/users/<UID>/avatars/<HASH>.<ext>
 *   - Banner        : cdn.discordapp.com/banners/<UID>/<HASH>.<ext>
 * The /users/ form is checked BEFORE /avatars/ since per-server URLs contain
 * both segments, but only /users/<UID>/ holds the user's ID.
 */
function userIdFromCdnUrl(url) {
  if (!url) return null;
  const m = url.match(/\/users\/(\d+)\//) || url.match(/\/avatars\/(\d+)\//) || url.match(/\/banners\/(\d+)\//);
  return m ? m[1] : null;
}

/** Scans every Discord-CDN image inside a message wrapper for a user ID. Returns the first one found, or null. */
function scanMessageForUid(msg) {
  const candidates = msg.querySelectorAll('img[src*="cdn.discordapp.com"], img[src*="discordapp.net"]');
  for (const c of candidates) {
    const id = userIdFromCdnUrl(c.src);
    if (id) return id;
  }
  return null;
}

/**
 * Extracts a user ID from any clickable element in Discord. Tries (in order):
 *   1. avatar/banner img at or near the click target
 *   2. any CDN-served image inside the enclosing message
 *   3. for grouped follow-up messages (no avatar header), walk back through
 *      previous siblings until a sibling yields a user ID — that's the group
 *      head, which by Discord's grouping rules is the same author
 *   4. an explicit data-user-id attribute (mentions, popout elements)
 */
function extractUserId(elem) {
  const img = (elem.closest && elem.closest("img")) || (elem.querySelector && elem.querySelector("img"));
  const fromImg = img && userIdFromCdnUrl(img.src);
  if (fromImg) return fromImg;

  const msg = elem.closest && elem.closest('[id^="chat-messages-"]');
  if (msg) {
    const direct = scanMessageForUid(msg);
    if (direct) return direct;

    // Grouped follow-up: walk back through previous siblings to the group head.
    let cursor = msg.previousElementSibling;
    while (cursor) {
      const id = scanMessageForUid(cursor);
      if (id) return id;
      cursor = cursor.previousElementSibling;
    }
  }

  const withData = elem.closest && elem.closest("[data-user-id]");
  return (withData && withData.getAttribute("data-user-id")) || null;
}

/** Arms selection mode. Re-clicking the same Select button cancels. Logs a hint about which kind of element to click. */
function startSelection(input, type, label, button) {
  if (selection && selection.button === button) {
    cancelSelection();
    log.info("已取消选择。");
    return;
  }
  if (selection) cancelSelection();

  selection = { input, type, label, button };
  button.classList.add("active");
  document.body.classList.add("undiscord-selecting");
  document.addEventListener("click", handleSelectionClick, true);
  document.addEventListener("keydown", handleSelectionKey, true);
  document.addEventListener("keyup", handleSelectionKey, true);
  resetSelectionTimeout();

  const target =
    (type === "user" || type === "user-single") ? "用户、头像或消息作者" :
    (type === "server" || type === "server-multi") ? "左侧栏中的服务器图标" :
    (type === "channel" || type === "channel-multi") ? "侧栏中的频道（或其中任意消息）" :
                                                         "消息";
  log.info(`选择模式已启用（${label}）：请在 Discord 中点击${target}以捕获其 ID。按住 Shift 可连续选择，按 Esc 取消。`);
}

/** Tears down selection mode — removes listeners, clears the timeout, removes the active styling on the Select button. */
function cancelSelection() {
  if (!selection) return;
  selection.button.classList.remove("active");
  selection.button.classList.remove("shift-locked");
  document.body.classList.remove("undiscord-selecting");
  document.removeEventListener("click", handleSelectionClick, true);
  document.removeEventListener("keydown", handleSelectionKey, true);
  document.removeEventListener("keyup", handleSelectionKey, true);
  if (selectionTimeout) { clearTimeout(selectionTimeout); selectionTimeout = null; }
  selection = null;
}

/** Restarts the 60-second auto-cancel timer. Called on selection start and after each Shift-held capture. */
function resetSelectionTimeout() {
  if (selectionTimeout) clearTimeout(selectionTimeout);
  selectionTimeout = setTimeout(() => {
    log.warn("选择模式已超过 60 秒，已自动取消。");
    cancelSelection();
  }, SELECTION_TIMEOUT_MS);
}

/** Capture-phase click handler — fires before Discord's own listeners so popouts / message-jumps are suppressed when extracting. Clicks inside the panel bubble through normally. */
function handleSelectionClick(e) {
  if (e.target.closest("#undiscord") || e.target.closest("#undiscord-server-btn")) return;

  e.preventDefault();
  e.stopPropagation();

  const t = selection.type;
  const id =
    (t === "user" || t === "user-single") ? extractUserId(e.target) :
    t === "message" ? extractMessageId(e.target) :
    (t === "server" || t === "server-multi") ? extractServerId(e.target) :
    (t === "channel" || t === "channel-multi") ? extractChannelId(e.target) : null;
  if (!id) {
    const typeLabel = selection.type === "user-single" ? "用户" :
      selection.type.startsWith("server") ? "服务器" :
      selection.type.startsWith("channel") ? "频道" : "消息";
    log.warn(`无法从点击的元素中提取${typeLabel} ID，已取消选择。`);
    cancelSelection();
    return;
  }
  insertCapturedId(selection.input, selection.label, id, selection.type);

  // Shift-held → stay in selection mode for another capture; refresh the
  // timeout so a long batch run doesn't auto-cancel mid-stream.
  if (e.shiftKey) {
    resetSelectionTimeout();
  } else {
    cancelSelection();
  }
}

/** Unified keydown/keyup handler. Esc cancels selection. Shift down/up toggles the shift-lock visual on the active button (light purple while held, amber otherwise). */
function handleSelectionKey(e) {
  if (e.key === "Escape" && e.type === "keydown") {
    cancelSelection();
    log.info("已取消选择。");
    return;
  }
  if (e.key === "Shift" && selection) {
    if (e.type === "keydown") selection.button.classList.add("shift-locked");
    else selection.button.classList.remove("shift-locked");
  }
}

/**
 * Inserts a captured ID according to its type:
 *   - user / server-multi / channel-multi → append to bound input (CSV, dedup)
 *   - user-single / message → overwrite bound input
 *   - server / channel → route through addPair() into the queue
 */
function insertCapturedId(input, label, id, type) {
  if (type === "user" || type === "server-multi" || type === "channel-multi") {
    const kindLabel = type === "user" ? "用户" : type === "server-multi" ? "服务器" : "频道";
    const list = parseCsvList(input.value);
    if (list.includes(id)) {
      log.info(`${dot(id)} 已存在于${label}中，已跳过。`);
      return;
    }
    list.push(id);
    input.value = list.join(",");
    log.success(`已捕获${kindLabel} ID ${dot(id)} → ${label}。`);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  } else if (type === "user-single") {
    const previous = input.value.trim();
    if (previous === id) {
      log.info(`${dot(id)} 已设置在${label}中，无需更改。`);
      return;
    }
    input.value = id;
    if (previous) log.success(`已捕获用户 ID ${dot(id)} → ${label}（已覆盖 ${dot(previous)}）。`);
    else log.success(`已捕获用户 ID ${dot(id)} → ${label}。`);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  } else if (type === "server") {
    // @me isn't a runnable server-wide target (the search endpoint requires a
    // specific channel ID for DMs). Same guard as the Add Server button uses.
    if (id === "@me") {
      return log.warn("在“服务器 ID”中使用“选择”捕获到了 @me，但服务器范围的 @me 不是有效删除目标——请在“私信”区域使用“添加私信”，或在“频道 ID”中使用“选择”来指定私信。");
    }
    log.success(`已捕获服务器 ID ${dot(id)} → 正在加入队列（服务器范围）。`);
    addPair(id, "");
  } else if (type === "channel") {
    // Resolve the parent server from the URL. Three URL shapes:
    //   /channels/<guildId>/<channelId>  — inside a guild channel
    //   /channels/@me/<channelId>        — inside an open DM
    //   /channels/@me                    — friends tab (DM list, no open convo)
    let parentServer = null;
    const urlMatch = location.href.match(/channels\/([\w@]+)\/\d+/);
    if (urlMatch) {
      parentServer = urlMatch[1];
    } else if (/\/channels\/@me\b/.test(location.href)) {
      parentServer = "@me";
    } else {
      return log.warn(`已捕获频道 ID ${dot(id)}，但无法从 URL 判断所属服务器——请先在 Discord 中打开该频道（或其所属服务器），然后重试。`);
    }
    if (parentServer === "@me") {
      log.success(`已捕获私信频道 ID ${dot(id)} → 正在加入队列。`);
    } else {
      log.success(`已捕获频道 ID ${dot(id)} → 正在加入服务器 ${dot(parentServer)} 的队列。`);
    }
    addPair(parentServer, id);
  } else {
    input.value = id;
    log.success(`已捕获消息 ID ${dot(id)} → ${label}。`);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

/** Appends one ID to a comma-separated multi-input field with dedup. Used by the import-mode Exclude Server / Exclude Channel Add buttons; mirrors the General queue's addPair pattern but for a flat CSV list. Distinct from insertCapturedId (which logs "Captured ..." for Select-mode flow) so the Add button's log line reads naturally. */
function addToCsvField(input, label, id) {
  const list = parseCsvList(input.value);
  if (list.includes(id)) {
    log.info(`${dot(id)} 已存在于${label}中，已跳过。`);
    return;
  }
  list.push(id);
  input.value = list.join(",");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  log.success(`已将 ${dot(id)} 添加到${label}。`);
}

/** Removes one ID from a comma-separated multi-input field. No-op (with a log line) when the ID isn't present. Used by the import-mode Exclude Server / Exclude Channel Delete buttons; mirrors the General queue's removeChannel/removeServer pattern but for a flat CSV list. */
function removeFromCsvField(input, label, id) {
  const list = parseCsvList(input.value);
  const idx = list.indexOf(id);
  if (idx === -1) {
    log.info(`${dot(id)} 不在${label}中，无需移除。`);
    return;
  }
  list.splice(idx, 1);
  input.value = list.join(",");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  log.success(`已从${label}移除 ${dot(id)}。`);
}

/** Live-search channel exclusion list ("Exclude Channel" in General) — the channels a server-wide wipe leaves alone. Read from the input on every run so mid-session edits apply to the next run. Returns [] when unset. */
function readExcludeChannelList() {
  return parseCsvList($("input#excludeChannelIds").value);
}

/** Wires a Select button to startSelection() with the matching input, type, and label. */
function bindSelector(buttonId, inputId, type, label) {
  const button = $(`button#${buttonId}`);
  const input = $(`input#${inputId}`);
  button.onclick = () => startSelection(input, type, label, button);
}

/** Wires a Clear button to wipe a text input and log the action. No-op (with an "already empty" log) when the input is already empty. */
function bindClearButton(buttonId, inputId, label) {
  const button = $(`button#${buttonId}`);
  const input = $(`input#${inputId}`);
  button.onclick = () => {
    if (!input.value.trim()) return log.info(`${label} 已经为空。`);
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    log.info(`已清空${label}。`);
  };
}


// ============================================================================
// MULTI-USER PASTE HANDLING
// ----------------------------------------------------------------------------
// Special paste handlers for ID-bearing inputs. Snowflake-shaped clipboards
// get processed; other clipboards fall through to native paste.
// ============================================================================

/** Paste handler for multi-value ID inputs. Snowflake-shaped clipboards (single ID or comma-separated list) append to the existing value with deduplication. Other clipboards fall through to native paste. */
function bindMultiUserPaste(input, label) {
  input.addEventListener("paste", e => {
    const text = ((e.clipboardData || window.clipboardData).getData("text") || "").trim();
    if (!/^\d{15,25}(\s*,\s*\d{15,25})*$/.test(text)) return; // not an ID list — let native paste run

    e.preventDefault();
    const incoming = parseCsvList(text);
    const list = parseCsvList(input.value);

    let added = 0, dupes = 0;
    for (const id of incoming) {
      if (list.includes(id)) dupes++;
      else { list.push(id); added++; }
    }

    input.value = list.join(",");
    input.dispatchEvent(new Event("input", { bubbles: true }));

    if (added > 0) log.info(`已将 ${added} 个 ID 追加到${label}。`);
    if (dupes > 0) log.info(`${dupes} 个 ID 已存在于${label}中，已跳过。`);
  });
}

/** Paste handler for single-value ID inputs (Include @user — Discord's `mentions=` query param accepts only one ID per request). New paste overwrites the field. Non-snowflake clipboards fall through to native paste. */
function bindSingleUserPaste(input, label) {
  input.addEventListener("paste", e => {
    const text = ((e.clipboardData || window.clipboardData).getData("text") || "").trim();
    if (!/^\d{15,25}$/.test(text)) return;

    e.preventDefault();
    const previous = input.value.trim();
    if (previous === text) {
      log.info(`${label}：${dot(text)} 已设置，无需更改。`);
      return;
    }
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    if (previous) log.info(`${label}：已将 ${dot(previous)} 替换为 ${dot(text)}。`);
    else log.info(`${label}：已设置为 ${dot(text)}。`);
  });
}


// ============================================================================
// LOG SINK
// ----------------------------------------------------------------------------
// Renders log entries into the in-panel log area. Wired in as the global log
// sink (setLogFn) once initUI() has the DOM ready, so anything called via
// `log.info()` / `log.error()` / etc shows up in the panel.
// ============================================================================

const LOG_MAX_ENTRIES = 1000; // 超过上限时删除最早日志，避免长任务无限增长 DOM。

// 日志使用少量 HTML 来显示帮助文本和主播模式脱敏结果；其余内容
// 一律先转义，避免消息正文中的 <...> 被当成页面 HTML 执行。
const SAFE_LOG_MARKUP = /<\/?(?:b|i|code|br)>|<span class="sm-(?:real|redacted)">|<\/span>|&(?:amp|lt|gt|quot|#039|nbsp|rarr|hellip);/g;
function sanitizeLogArg(value) {
  const raw = String(value);
  const tokens = [];
  const marked = raw.replace(SAFE_LOG_MARKUP, match => {
    const token = `\u0000UDL_SAFE_${tokens.length}\u0000`;
    tokens.push(match);
    return token;
  });
  let escaped = escapeHTML(marked);
  escaped = escaped.replace(/\u0000UDL_SAFE_(\d+)\u0000/g, (_, i) => tokens[Number(i)]);
  return escaped;
}

/** Renders a single log entry into the in-panel log area. Auto-trims oldest entries above LOG_MAX_ENTRIES; mirrors errors to the devtools console. */
function printLog(type = "", args) {
  // For Errors, force serialization of normally-non-enumerable props (message, stack, etc).
  const html = args.map(o => {
    const value = typeof o === "object"
      ? JSON.stringify(o, o instanceof Error ? Object.getOwnPropertyNames(o) : null)
      : o;
    return sanitizeLogArg(value);
  }).join("\t");
  ui.logArea.insertAdjacentHTML("beforeend", `<div class="log log-${type}">${html}</div>`);
  while (ui.logArea.childElementCount > LOG_MAX_ENTRIES) ui.logArea.firstElementChild.remove();
  if (ui.autoScroll.checked) ui.logArea.lastElementChild.scrollIntoView(false);
  if (type === "error") console.error(LOG_PREFIX, ...args);
}


// ============================================================================
// CORE EVENT BINDINGS
// ----------------------------------------------------------------------------
// Wires the core's lifecycle callbacks (onStart / onProgress / onJob /
// onStop) into UI updates: morphs the primary action button between Delete
// (idle) and Stop (running), flips the trash icon (FAB and server-bar
// variant) into its red/active running state, updates the visual progress
// bar, and writes the live progress text into the top-bar slot.
// ============================================================================

// Per-second elapsed-time ticker. onProgress only fires after each delete
// completes, so elapsed time would freeze during the long search-delay waits
// between pages without it. lastRemainingMs caches the most recent ETR sample
// from onProgress so the ticker can rerender both halves of the footer.
let elapsedTicker = null;
let lastRemainingMs = 0;

/** Refreshes the footer's elapsed/remaining readout. Called from the per-second ticker AND from onProgress (where lastRemainingMs is also refreshed from stats.etr). */
function renderFooterTime() {
  if (!undiscordCore.stats.startTime) return;
  const elapsed = msToHMS(Date.now() - undiscordCore.stats.startTime.getTime());
  const remaining = msToHMS(lastRemainingMs);
  ui.footerTime.textContent = `已用时 ${elapsed} · 剩余 ${remaining}`;
}

/** Registers core lifecycle hooks. Called once at the end of initUI(). */
function bindCoreEvents() {
  undiscordCore.onStart = () => {
    const btn = $("button#start");
    btn.textContent = "🛑 停止";
    btn.title = "停止删除任务";
    ui.progressMain.style.display = "block";
    ui.topBarSlot.innerHTML = "<span class=\"status-line status-running\">启动中…</span>";

    // 1 s cadence — keeps the digits moving even while the loop is sleeping
    // through a search-delay wait. Remaining stays at its last onProgress
    // sample (an estimate that only changes meaningfully on each delete).
    lastRemainingMs = 0;
    if (elapsedTicker) clearInterval(elapsedTicker);
    elapsedTicker = setInterval(renderFooterTime, 1000);
    renderFooterTime();

    // Drain any one-shot notice startAction stashed (logged here so it lands
    // right after the "Started at..." line instead of getting wiped by the
    // log-clear that runs between startAction and run()).
    if (pendingStartNotice) {
      log.info(pendingStartNotice);
      pendingStartNotice = null;
    }
  };

  undiscordCore.onProgress = (state, stats) => {
    const value = state.delCount + state.failCount;
    const max = Math.max(state.grandTotal, value);

    if (max) {
      const percent = Math.round(value / max * 100) + "%";
      ui.topBarSlot.innerHTML =
        "<span class=\"status-line status-running\">删除中… " +
        `| (${value}/${max}) ${percent} ` +
        `| 失败：${state.failCount} ` +
        (state._skippedIds.size ? `| 跳过：${state._skippedIds.size} ` : "") +
        `| 任务 ${currentJobInfo.i}/${currentJobInfo.n} |</span>`;
      ui.progressMain.setAttribute("max", max);
      ui.progressMain.value = value;
    } else {
      ui.topBarSlot.innerHTML = "<span class=\"status-line status-running\">处理中…</span>";
      ui.progressMain.removeAttribute("value");
    }

    // Cache the new ETR sample, then rerender the footer immediately so the
    // user sees it without waiting for the next ticker beat.
    lastRemainingMs = stats.etr;
    renderFooterTime();

    // Sync the stepper display to reflect any rate-limit bump/decay applied by core.
    setDelayDisplay("searchDelay", undiscordCore.options.searchDelay);
    setDelayDisplay("deleteDelay", undiscordCore.options.deleteDelay);
  };

  // Per-job batch position — fired by core.runBatch before each per-job run().
  undiscordCore.onJob = (i, n) => { currentJobInfo = { i, n }; };

  undiscordCore.onStop = () => {
    const btn = $("button#start");
    btn.textContent = "▶ 删除";
    btn.title = "开始删除任务";
    ui.progressMain.style.display = "none";
    if (elapsedTicker) { clearInterval(elapsedTicker); elapsedTicker = null; }
    ui.footerTime.textContent = ""; // clear elapsed/remaining when idle
    renderTopBar();
  };
}


// ============================================================================
// SELECTION SNAPSHOT / RESET / BATCH QUEUE
// ----------------------------------------------------------------------------
// The Reset Selection and Batch Selection sidebar buttons let the user build
// a meta-batch — multiple independent selections, each with its own filters,
// target queue, and intervals, run sequentially when Delete is finally
// clicked. captureSnapshot reads every form input into a plain object;
// applySnapshot writes one back; resetAllSelection clears the form.
// selectionQueue holds queued snapshots; the current form is appended last
// in startAction so queue-then-delete runs queued batches first and the
// "live" form last.
//
// Two safeguards run at queue time:
//   - Pre-flight permission check (search-mode snapshots with non-self
//     authors) — failures reject the snapshot, not just the run later.
//   - Dedup + redundancy detection — exact-match snapshots are blocked
//     (snapshotKey); strictly-subsumed snapshots log a warning but queue
//     anyway (snapshotASubsumesB). Anything finer is the user's call.
// ============================================================================

let selectionQueue = []; // array of snapshots; runs sequentially on next Delete

// Identity tags for imported sets so dedup compares by reference, not by
// re-stringifying the (potentially huge) parsed export every time.
const importIdMap = new WeakMap();
let nextImportId = 1;
function importIdOf(set) {
  if (!set) return null;
  if (!importIdMap.has(set)) importIdMap.set(set, nextImportId++);
  return importIdMap.get(set);
}

/** Stable-stringifies a snapshot for dedup comparison. importedSet is replaced with an identity tag (so two snapshots referencing the same parsed export hash to the same key, regardless of its contents); every other field is captured by value via JSON.stringify (insertion-order-stable in V8/SpiderMonkey/JSC, and captureSnapshot always builds the object in the same field order). */
function snapshotKey(snap) {
  return JSON.stringify({ ...snap, importedSet: importIdOf(snap.importedSet) });
}

/** Returns true when every "narrowing" filter knob in `snap` is at its default state. Pinned-mode and NSFW are deliberately not checked — those interact with B's matching values in non-monotonic ways, so the caller compares them between A and B instead. */
function isFilterless(snap) {
  // Search filter
  if (snap.content) return false;
  if (snap.hasLink || snap.hasImage || snap.hasVideo || snap.hasSound) return false;
  if (snap.hasSticker || snap.hasPoll || snap.hasEmbed || snap.hasForward) return false;
  if (snap.mentionsId) return false;
  if (snap.mentionEveryone) return false;
  // Skip (Delete) filter
  if (snap.excludeSearch) return false;
  if (snap.excludeLink || snap.excludeImage || snap.excludeVideo || snap.excludeSound) return false;
  if (snap.excludeSticker || snap.excludePoll || snap.excludeEmbed || snap.excludeForward) return false;
  if (snap.excludeMentionsId) return false;
  if (snap.excludeMentionEveryone) return false;
  if (snap.excludeExtensions) return false;
  if (snap.excludeExtensionPills?.length) return false;
  // Keep-list — a snapshot that spares channels is by definition not a
  // delete-everything pass, so it can't subsume another snapshot.
  if (snap.excludeChannelIds) return false;
  // Import-only exclusions
  if (snap.importExcludeServers || snap.importExcludeChannels || snap.importExcludeUsers) return false;
  if (snap.importExcludeAllServers || snap.importExcludeAllChannels || snap.importExcludeAllDms) return false;
  return true;
}

/** Returns the snapshot's effective {minMs, maxMs} interval. minId/maxId override minDate/maxDate (matching run-time precedence). The Discord-epoch default for minDate is treated as "no lower bound" so factory-default snapshots compare cleanly. */
function intervalOf(snap) {
  let minMs = -Infinity, maxMs = Infinity;
  if (snap.minId) minMs = snowflakeToMs(snap.minId);
  else if (snap.minDate && snap.minDate !== DISCORD_EPOCH_LOCAL) minMs = new Date(snap.minDate).getTime();
  if (snap.maxId) maxMs = snowflakeToMs(snap.maxId);
  else if (snap.maxDate) maxMs = new Date(snap.maxDate).getTime();
  return { minMs, maxMs };
}

/** Returns the snapshot's author list as a Set. Empty Author ID resolves to a `__self__` sentinel — across snapshots the user is always the same identity, so two empty-author snapshots compare as authoring the same set without needing to actually look up the self ID. */
function authorSetOf(snap) {
  const list = parseCsvList(snap.authorId);
  return list.length ? new Set(list) : new Set(["__self__"]);
}

/** Returns true when every (server, channel) target in `bTargets` is covered by some target in `aTargets`. A server-wide entry in A (channelId === '') covers any (S, *) in B with the same server; a channel-specific entry only covers an exact match. */
function targetsCoverAll(aTargets, bTargets) {
  for (const b of bTargets) {
    let covered = false;
    for (const a of aTargets) {
      if (a.guildId !== b.guildId) continue;
      if (a.channelId === "" || a.channelId === b.channelId) { covered = true; break; }
    }
    if (!covered) return false;
  }
  return true;
}

/** Returns true when running snapshot `a` would delete every message snapshot `b` would, leaving `b` to do mostly-redundant work (404s on already-deleted messages). Both must share a mode (live-search vs same imported set), `a` must be filterless, and `a`'s scope/author/interval must be a superset of `b`'s. Pinned-mode and NSFW exclusion must align in live-search mode (import bypasses both). */
function snapshotASubsumesB(a, b) {
  if (Boolean(a.importedSet) !== Boolean(b.importedSet)) return false;
  if (a.importedSet && a.importedSet !== b.importedSet) return false;
  if (!isFilterless(a)) return false;

  if (!a.importedSet) {
    // Live-search-mode-only: pinned-mode and NSFW affect the deletion set in
    // ways that aren't monotonic in the user's tunables — require an exact
    // match on both rather than try to model the lattice.
    if (a.pinnedMode !== b.pinnedMode) return false;
    if (a.excludeNsfw !== b.excludeNsfw) return false;

    const aAuth = authorSetOf(a), bAuth = authorSetOf(b);
    for (const id of bAuth) if (!aAuth.has(id)) return false;

    const { targets: aTargets } = parseTargets(a.guildId, a.channelId);
    const { targets: bTargets } = parseTargets(b.guildId, b.channelId);
    if (!targetsCoverAll(aTargets, bTargets)) return false;
  }

  const aInt = intervalOf(a), bInt = intervalOf(b);
  if (aInt.minMs > bInt.minMs) return false;
  if (aInt.maxMs < bInt.maxMs) return false;

  return true;
}

/** Refreshes the queue counter badge and the drop-batches button. Both hide entirely when the queue is empty so the badge row collapses to whatever else is there (just the import-mode chip, or nothing at all). */
function renderQueueBadge() {
  const badge = $("#queueBadge");
  const drop = $("button#dropBatches");
  if (!badge) return;
  const n = selectionQueue.length;
  if (n === 0) {
    badge.style.display = "none";
    if (drop) drop.style.display = "none";
    return;
  }
  badge.style.display = "inline-flex";
  badge.textContent = `已排队：${n}`;
  if (drop) drop.style.display = "inline-flex";
}

// ============================================================================
// SETTINGS PERSISTENCE
// ----------------------------------------------------------------------------
// The whole form survives page reloads. Storage is Discord's own origin
// localStorage (same place the token lives), accessed through the iframe
// trick in helpers. Read/write go through captureSnapshot / applySnapshot so
// the persisted field set can never drift from what a batch snapshot carries.
// importedSet is deliberately excluded — the parsed data export is far too
// large and is re-picked from disk anyway. Footer toggles (streamer mode /
// auto scroll) are global UI prefs and ride along separately.
// ============================================================================

const SETTINGS_KEY = "undiscordLite.settings.v1";

/** Serializes the current form into localStorage. Called debounced on any panel input/change, plus explicitly at run start, form reset, and snapshot apply. */
function persistSettings() {
  const s = {
    ...captureSnapshot(),
    importedSet: undefined, // JSON.stringify drops undefined — never persist the parsed export
    streamerMode: $("input#streamerMode").checked,
    autoScroll:   $("input#autoScroll").checked,
  };
  writeLocalStorage(SETTINGS_KEY, JSON.stringify(s));
}

/** Replays the saved settings into the form. Returns true when something was restored. Missing keys (settings saved by an older version) fall back to the current factory defaults via the merge. */
function restoreSettings() {
  const raw = readLocalStorage(SETTINGS_KEY);
  if (!raw) return false;
  let s;
  try { s = JSON.parse(raw); }
  catch (err) { log.warn("上次设置的存档无法解析，已忽略。"); return false; }
  if (!s || typeof s !== "object") return false;
  applySnapshot({ ...captureSnapshot(), ...s });
  if (typeof s.streamerMode === "boolean") {
    const sm = $("input#streamerMode");
    sm.checked = s.streamerMode;
    sm.dispatchEvent(new Event("change", { bubbles: true })); // syncs .streamer-on
  }
  if (typeof s.autoScroll === "boolean") $("input#autoScroll").checked = s.autoScroll;
  return true;
}

/** Snapshots every form input that affects a run into a plain object, ready to be replayed via applySnapshot. The `importedSet` reference is captured by identity (not deep copy) — only one import is loaded at a time, and the user clearing it shouldn't retroactively invalidate already-queued snapshots that were captured against it. */
function captureSnapshot() {
  return {
    // General
    authorId:        $("input#authorId").value.trim(),
    excludeNsfw:     $("input#excludeNsfw").checked,
    guildId:         $("input#guildId").value,
    channelId:       $("input#channelId").value,
    excludeGroupDms: $("input#excludeGroupDms").checked,
    // Search filter
    content:          $("input#search").value.trim(),
    hasLink:          $("input#hasLink").checked,
    hasImage:         $("input#hasImage").checked,
    hasVideo:         $("input#hasVideo").checked,
    hasSound:         $("input#hasSound").checked,
    hasSticker:       $("input#hasSticker").checked,
    hasPoll:          $("input#hasPoll").checked,
    hasEmbed:         $("input#hasEmbed").checked,
    hasForward:       $("input#hasForward").checked,
    mentionsId:       $("input#mentionsId").value.trim(),
    mentionEveryone:  $("input#mentionEveryone").checked,
    pinnedMode:       $("select#pinnedMode").value,
    // Delete filter
    excludeSearch:           $("input#excludeSearch").value.trim(),
    excludeMatchMode:        $("select#excludeMatchMode").value,
    excludeLink:             $("input#excludeLink").checked,
    excludeImage:            $("input#excludeImage").checked,
    excludeVideo:            $("input#excludeVideo").checked,
    excludeSound:            $("input#excludeSound").checked,
    excludeSticker:          $("input#excludeSticker").checked,
    excludePoll:             $("input#excludePoll").checked,
    excludeEmbed:            $("input#excludeEmbed").checked,
    excludeForward:          $("input#excludeForward").checked,
    excludeMentionsId:       $("input#excludeMentionsId").value.trim(),
    excludeMentionEveryone:  $("input#excludeMentionEveryone").checked,
    excludeExtensions:       $("input#excludeExtensions").value.trim(),
    excludeChannelIds:       $("input#excludeChannelIds").value.trim(),
    excludeExtensionPills:   Array.from(ui.undiscordWindow.querySelectorAll("input[data-ext]"))
                                  .filter(el => el.checked)
                                  .map(el => el.dataset.ext),
    // Intervals
    minId:    $("input#minId").value.trim(),
    maxId:    $("input#maxId").value.trim(),
    minDate:  $("input#minDate").value,
    maxDate:  $("input#maxDate").value,
    // Delays
    searchDelay: getDelayMs("searchDelay"),
    deleteDelay: getDelayMs("deleteDelay"),
    // Import-mode exclusions (only meaningful when an import is loaded)
    importedSet:                importedSet,
    importExcludeServers:       $("input#importExcludeServers").value.trim(),
    importExcludeChannels:      $("input#importExcludeChannels").value.trim(),
    importExcludeUsers:         $("input#importExcludeUsers").value.trim(),
    importExcludeAllServers:    $("input#importExcludeAllServers").checked,
    importExcludeAllChannels:   $("input#importExcludeAllChannels").checked,
    importExcludeAllDms:        $("input#importExcludeAllDms").checked,
  };
}

/** Writes a snapshot back into every form input — the inverse of captureSnapshot. Called once per snapshot during a meta-batch run, before the dispatch into core. The trailing renderQueue() refreshes the top-bar synopsis to match the freshly-applied target list. */
function applySnapshot(snap) {
  $("input#authorId").value = snap.authorId;
  $("input#excludeNsfw").checked = snap.excludeNsfw;
  $("input#guildId").value = snap.guildId;
  $("input#channelId").value = snap.channelId;
  $("input#excludeGroupDms").checked = snap.excludeGroupDms;

  $("input#search").value = snap.content;
  $("input#hasLink").checked = snap.hasLink;
  $("input#hasImage").checked = snap.hasImage;
  $("input#hasVideo").checked = snap.hasVideo;
  $("input#hasSound").checked = snap.hasSound;
  $("input#hasSticker").checked = snap.hasSticker;
  $("input#hasPoll").checked = snap.hasPoll;
  $("input#hasEmbed").checked = snap.hasEmbed;
  $("input#hasForward").checked = snap.hasForward;
  $("input#mentionsId").value = snap.mentionsId;
  $("input#mentionEveryone").checked = snap.mentionEveryone;
  $("select#pinnedMode").value = snap.pinnedMode;

  $("input#excludeSearch").value = snap.excludeSearch;
  $("select#excludeMatchMode").value = snap.excludeMatchMode;
  $("input#excludeLink").checked = snap.excludeLink;
  $("input#excludeImage").checked = snap.excludeImage;
  $("input#excludeVideo").checked = snap.excludeVideo;
  $("input#excludeSound").checked = snap.excludeSound;
  $("input#excludeSticker").checked = snap.excludeSticker;
  $("input#excludePoll").checked = snap.excludePoll;
  $("input#excludeEmbed").checked = snap.excludeEmbed;
  $("input#excludeForward").checked = snap.excludeForward;
  $("input#excludeMentionsId").value = snap.excludeMentionsId;
  $("input#excludeMentionEveryone").checked = snap.excludeMentionEveryone;
  $("input#excludeExtensions").value = snap.excludeExtensions;
  $("input#excludeChannelIds").value = snap.excludeChannelIds;
  const pillSet = new Set(snap.excludeExtensionPills || []);
  for (const el of ui.undiscordWindow.querySelectorAll("input[data-ext]")) {
    el.checked = pillSet.has(el.dataset.ext);
  }

  $("input#minId").value = snap.minId;
  $("input#maxId").value = snap.maxId;
  $("input#minDate").value = snap.minDate;
  $("input#maxDate").value = snap.maxDate;

  setDelayDisplay("searchDelay", snap.searchDelay);
  setDelayDisplay("deleteDelay", snap.deleteDelay);

  $("input#importExcludeServers").value = snap.importExcludeServers;
  $("input#importExcludeChannels").value = snap.importExcludeChannels;
  $("input#importExcludeUsers").value = snap.importExcludeUsers;
  $("input#importExcludeAllServers").checked = snap.importExcludeAllServers;
  $("input#importExcludeAllChannels").checked = snap.importExcludeAllChannels;
  $("input#importExcludeAllDms").checked = snap.importExcludeAllDms;

  persistSettings(); // form writes don't fire events — save the applied snapshot explicitly
  renderQueue();
}

/** Resets every form input to its default. Wired to the Reset Selection sidebar button, and called after a successful Batch Selection so the form is empty for the next snapshot. Streamer mode and Auto scroll (footer toggles) are NOT touched — those are global UI preferences, not per-batch. The log area is also untouched (use Clear Log for that). */
function resetAllSelection() {
  $("input#authorId").value = "";
  $("input#excludeNsfw").checked = false;
  $("input#guildId").value = "";
  $("input#channelId").value = "";
  $("input#excludeGroupDms").checked = false;

  $("input#search").value = "";
  $("input#hasLink").checked = false;
  $("input#hasImage").checked = false;
  $("input#hasVideo").checked = false;
  $("input#hasSound").checked = false;
  $("input#hasSticker").checked = false;
  $("input#hasPoll").checked = false;
  $("input#hasEmbed").checked = false;
  $("input#hasForward").checked = false;
  $("input#mentionsId").value = "";
  $("input#mentionEveryone").checked = false;
  $("select#pinnedMode").value = "exclude";

  $("input#excludeSearch").value = "";
  $("select#excludeMatchMode").value = "substring";
  $("input#excludeLink").checked = false;
  $("input#excludeImage").checked = false;
  $("input#excludeVideo").checked = false;
  $("input#excludeSound").checked = false;
  $("input#excludeSticker").checked = false;
  $("input#excludePoll").checked = false;
  $("input#excludeEmbed").checked = false;
  $("input#excludeForward").checked = false;
  $("input#excludeMentionsId").value = "";
  $("input#excludeMentionEveryone").checked = false;
  $("input#excludeExtensions").value = "";
  $("input#excludeChannelIds").value = "";
  for (const el of ui.undiscordWindow.querySelectorAll("input[data-ext]")) el.checked = false;

  $("input#minId").value = "";
  $("input#maxId").value = "";
  $("input#minDate").value = DISCORD_EPOCH_LOCAL;
  $("input#maxDate").value = "";

  setDelayDisplay("searchDelay", SEARCH_DEFAULT);
  setDelayDisplay("deleteDelay", DELETE_DEFAULT);
  undiscordCore.options.searchDelay = SEARCH_DEFAULT;
  undiscordCore.options.deleteDelay = DELETE_DEFAULT;

  $("input#importExcludeServers").value = "";
  $("input#importExcludeChannels").value = "";
  $("input#importExcludeUsers").value = "";
  $("input#importExcludeAllServers").checked = false;
  $("input#importExcludeAllChannels").checked = false;
  $("input#importExcludeAllDms").checked = false;

  persistSettings(); // the reset form is what a reload should restore
  renderQueue();
}


// ============================================================================
// PERMISSION PRE-FLIGHT
// ----------------------------------------------------------------------------
// Two-tier permission check before a batch runs.
//   1. Channel / 子区 level (decisive, no API call): PermissionStore.can resolves
//      a thread's perms through its parent channel, so it answers "can I delete
//      in *this* channel" exactly — tighter than the guild bitfield, which
//      ignores channel overwrites. false → abort; null (uncached channel, or a
//      whole-server target with no channel) → fall through to tier 2.
//   2. Server level (fallback, one call to /users/@me/guilds): indexes guilds
//      where the user has Manage Messages (0x2000) or Administrator (0x8) and
//      aborts any remaining job outside that index.
// DMs are skipped entirely (you only ever delete your own DM messages). Jobs
// whose author is you are skipped too — your own messages never need perms. An
// empty author filter ("all authors") is NOT skipped: deleting everyone's
// messages needs "管理消息" just like deleting one other user's does.
// ============================================================================

/** Returns true to proceed with the run, false to abort. Logs per-channel / per-server failures and a final aborted-by-pre-flight line on rejection. */
async function checkBatchPermissions(jobs, authToken) {
  const selfId = getAuthorId(); // user's own ID from the live user store; null if read fails

  // Jobs that need a permission verdict: non-DM targets whose author isn't you.
  // An empty authorId ("all authors") is included — deleting everyone's
  // messages needs "管理消息" just as much as deleting one other user's does.
  const pending = jobs.filter(job =>
    job.guildId !== "@me" && !(selfId && job.authorId === selfId));
  if (pending.length === 0) return true; // self-only or DM-only run

  log.info("预检：正在检查所需的“管理消息”权限…");

  // ---- Tier 1: channel / 子区 level (decisive, no API call) ----
  // PermissionStore resolves a thread's (子区) perms through its parent channel,
  // so this answers "can I delete in *this* channel" exactly. false → hard fail.
  // null → not cached (or a whole-server target with no channel); defer to tier 2.
  const channelFailures = [];
  const needsGuildCheck = [];
  for (const job of pending) {
    const can = canManageMessages(job.channelId);
    if (can === false) channelFailures.push(job);
    else if (can === null) needsGuildCheck.push(job);
    // can === true → cleared here; no server-level check needed for this job.
  }

  // ---- Tier 2: server level (fallback, one API call) ----
  const guildFailures = [];
  if (needsGuildCheck.length) {
    const pairs = new Map();
    for (const job of needsGuildCheck) {
      if (!pairs.has(job.guildId)) pairs.set(job.guildId, new Set());
      pairs.get(job.guildId).add(job.authorId || "<any>");
    }

    let guilds;
    try {
      const resp = await fetch("https://discord.com/api/v9/users/@me/guilds", {
        headers: authHeaders(authToken),
      });
      if (!resp.ok) {
        log.error(`预检：无法获取你的服务器列表（状态 ${resp.status}），已中止。`);
        return false;
      }
      guilds = await resp.json();
    } catch (err) {
      log.error("预检：获取服务器列表时发生网络错误，已中止。", err);
      return false;
    }

    // Index guilds where the user has Manage Messages (0x2000) or Admin (0x8).
    const MANAGE_MESSAGES = 0x2000n;
    const ADMINISTRATOR = 0x8n;
    const validServers = new Set();
    for (const g of guilds) {
      const perms = BigInt(g.permissions || "0");
      if ((perms & ADMINISTRATOR) || (perms & MANAGE_MESSAGES)) validServers.add(g.id);
    }

    for (const [serverId, authors] of pairs) {
      if (validServers.has(serverId)) continue;
      guildFailures.push({ serverId, authors: [...authors] });
    }
  }

  if (channelFailures.length === 0 && guildFailures.length === 0) {
    log.info("预检通过：你对所有目标频道都拥有“管理消息”权限。");
    return true;
  }

  for (const job of channelFailures) {
    const who = job.authorId ? `用户 ID ${dot(job.authorId)} 的消息` : "所有人的消息";
    log.error(`你在频道/子区 ${dot(job.channelId)} 中没有“管理消息”权限，无法删除${who}。`);
  }
  for (const f of guildFailures) {
    const ids = f.authors.filter(a => a !== "<any>");
    const parts = [];
    if (ids.length) parts.push(`用户 ID ${ids.map(dot).join("、")} 的消息`);
    if (ids.length !== f.authors.length) parts.push("所有人的消息");
    log.error(`你没有权限在服务器 ID ${dot(f.serverId)} 中删除${parts.join("、")}。`);
  }
  log.error("任务已因预检权限不足而中止。");
  return false;
}


// ============================================================================
// IMPORT CONTROLS
// ----------------------------------------------------------------------------
// Folder picker, summary line, Clear-import button. Idempotent: safe to call
// once on init.
// ============================================================================

/** Wires the import folder picker, the Clear-import button, and renders the summary line. */
function bindImportControls() {
  const picker = $("input#importPicker");

  $("button#importPick").onclick = () => picker.click();

  picker.addEventListener("change", async e => {
    const { files } = e.target;
    if (!files || files.length === 0) return;
    log.info(`正在解析导入数据中的 ${files.length} 个文件…`);
    let parsed;
    try {
      parsed = await parseExport(files);
    } catch (err) {
      log.error("导入失败：", err.message || String(err));
      // Reset the input so picking the same folder again still fires `change`.
      picker.value = "";
      return;
    }
    importedSet = parsed;
    renderImportSummary();
    ui.undiscordWindow.classList.add("import-mode");
    $("#importBadge").style.display = "inline-flex";
    log.success(`导入完成：${parsed.messages.length.toLocaleString()} 条消息，来自 ${parsed.channelCount} 个频道。`);
    // Per-source breakdown — pulled from channel.json (guild + name) and
    // index.json (DM friend usernames; recipients in channel.json are IDs only).
    log.info("── 导入数据明细 ──");
    for (const line of summarizeImport(parsed, dot)) log.info(`› ${line}`);
    log.info("常规队列、搜索筛选和删除筛选已跳过；日期范围和消息范围仍然生效。");
    // Reset so re-picking works.
    picker.value = "";
  });

  $("button#importClear").onclick = () => {
    if (!importedSet) return log.info("尚未导入数据。");
    importedSet = null;
    renderImportSummary();
    ui.undiscordWindow.classList.remove("import-mode");
    $("#importBadge").style.display = "none";
    log.info("导入数据已清除，已返回实时搜索模式。");
  };

  renderImportSummary();
}

/** Updates the import summary line and the top bar to reflect the current importedSet (or "No import loaded." when null). */
function renderImportSummary() {
  const el = $("#importSummary");
  if (!importedSet) {
    el.textContent = "尚未导入数据。";
  } else {
    const { messages, channelCount, oldestTs, newestTs } = importedSet;
    const fmt = ts => ts ? new Date(ts).toISOString().slice(0, 10) : "—";
    el.textContent = `已导入 ${messages.length.toLocaleString()} 条消息，来自 ${channelCount} 个频道 · 最早 ${fmt(oldestTs)} · 最晚 ${fmt(newestTs)}`;
  }
  renderTopBar();
}


// ============================================================================
// IMPORT FILTER LOOP
// ----------------------------------------------------------------------------
// Walks the imported message set and applies every filter in declared order,
// attributing each drop to exactly one bucket (the first predicate that
// matched). Returns the survivors plus per-bucket counts so the orchestrator
// can both queue the survivors and log a categorised breakdown.
// ============================================================================

/** Returns `{ filtered, skipReasons }` after applying every import-mode filter passed in `f`. Each rejected message is attributed to exactly one bucket. */
function applyImportFilters(messages, f) {
  const skipReasons = {
    allServers: 0, allChannels: 0, allDms: 0,
    servers: 0, channels: 0, dmUsers: 0,
    dateInterval: 0,
    text: 0, links: 0,
    mentions: 0, everyone: 0,
    attachments: 0, extensions: 0,
  };
  const filtered = [];
  for (const m of messages) {
    // Type-wide exclusions (the three "Exclude all" pills above the per-ID
    // selector lists). Checked first so whole categories short-circuit before
    // any per-record matching runs. excludeAllChannels backs the "Exclude
    // group DMs" pill — the option name predates the label.
    if (f.excludeAllServers && m.guildId && m.guildId !== "@me") { skipReasons.allServers++; continue; }
    if (f.excludeAllDms && m.type === "DM") { skipReasons.allDms++; continue; }
    if (f.excludeAllChannels && m.type === "GROUP_DM") { skipReasons.allChannels++; continue; }

    // Per-ID exclusion lists — applied after the wildcards so each wildcard
    // claims its skipReasons bucket before the per-ID checks can.
    if (f.excludeServersSet.size && f.excludeServersSet.has(m.guildId)) { skipReasons.servers++; continue; }
    if (f.excludeChannelsSet.size && f.excludeChannelsSet.has(m.channelId)) { skipReasons.channels++; continue; }
    if (f.excludeUsersSet.size && (m.type === "DM" || m.type === "GROUP_DM")
        && m.recipientIds?.some(id => f.excludeUsersSet.has(id))) { skipReasons.dmUsers++; continue; }

    const ts = new Date(m.timestamp).getTime();
    if (!Number.isFinite(ts) || ts < f.minMs || ts > f.maxMs) { skipReasons.dateInterval++; continue; }

    const content = m.content || "";
    if (f.contentMatch && f.contentMatch(content)) { skipReasons.text++; continue; }
    // Export carries no embed metadata; the bare URL regex on content is the
    // only signal available for "has a link".
    if (f.excludeLink && /https?:\/\//i.test(content)) { skipReasons.links++; continue; }

    // Image / Video / Sound bundle into one bucket since the UI groups them
    // visually under a single "Attachments" label in the breakdown.
    if ((f.excludeImage && m.attachments?.some(a => a.content_type?.startsWith("image/")))
     || (f.excludeVideo && m.attachments?.some(a => a.content_type?.startsWith("video/")))
     || (f.excludeSound && m.attachments?.some(a => a.content_type?.startsWith("audio/")))) {
      skipReasons.attachments++; continue;
    }

    if (f.mentionMatch && f.mentionMatch(content)) { skipReasons.mentions++; continue; }
    if (f.excludeMentionEveryone && /@everyone|@here/.test(content)) { skipReasons.everyone++; continue; }
    if (f.extensionMatch && f.extensionMatch(m.attachments)) { skipReasons.extensions++; continue; }

    filtered.push(m);
  }
  return { filtered, skipReasons };
}


// ============================================================================
// ORCHESTRATORS
// ----------------------------------------------------------------------------
// startAction (▶︎ Delete button) is a meta-orchestrator: it gathers every
// queued selection snapshot (selectionQueue) plus the current form (when not
// blank), then iterates them sequentially. Each iteration applies the snapshot
// to the live form and dispatches to runSearchModeFromForm or
// runImportModeFromForm based on the snapshot's mode.
//
// Per-snapshot dispatchers read every form input, validate, parse the queue,
// expand jobs across (target × author), run a permission pre-flight (search
// mode only), and call undiscordCore.run() (single target+author) or
// undiscordCore.runBatch() (multiple jobs).
// ============================================================================

/** Import-mode dispatcher. Pre-filters `importedSet` with every applicable filter, then hands a single synthetic job carrying an ImportSource into core. The caller (startAction) is responsible for the log-clear and the importedSet null-check. `askForConfirmation` lets the meta-orchestrator suppress the yes/no prompt for snapshots after the first — re-prompting between selections in the same meta-batch trains the user to click Yes without reading. */
async function runImportModeFromForm(authToken, askForConfirmation = true) {
  // Date / Messages interval: applied as a client-side pre-pass against each
  // record's ISO timestamp. Messages interval (snowflake range) wins when both
  // are set, mirroring search-mode precedence in runSearchModeFromForm below.
  const minId = $("input#minId").value.trim();
  const maxId = $("input#maxId").value.trim();
  const minDate = $("input#minDate").value.trim();
  const maxDate = $("input#maxDate").value.trim();

  if (minId && !/^\d+$/.test(minId)) return log.error(`“晚于此消息 ID”必须是数字形式的 Discord ID，实际输入：“${minId}”`);
  if (maxId && !/^\d+$/.test(maxId)) return log.error(`“早于此消息 ID”必须是数字形式的 Discord ID，实际输入：“${maxId}”`);
  if (minId && maxId && BigInt(minId) >= BigInt(maxId)) {
    return log.error("“晚于此消息 ID”必须早于（雪花 ID 更小）“早于此消息 ID”。");
  }

  let minMs = -Infinity, maxMs = Infinity;
  if (minId) minMs = snowflakeToMs(minId);
  else if (minDate) {
    const t = new Date(minDate).getTime();
    if (Number.isNaN(t)) return log.error("“起始日期”无效，请使用日期选择器重新输入。");
    minMs = t;
  }
  if (maxId) maxMs = snowflakeToMs(maxId);
  else if (maxDate) {
    const t = new Date(maxDate).getTime();
    if (Number.isNaN(t)) return log.error("“结束日期”无效，请使用日期选择器重新输入。");
    maxMs = t;
  }
  if (minMs >= maxMs) return log.error("日期或消息范围的前后边界相反——起始范围不早于结束范围。请调整，或点击“全部时间”。");

  // Read every Skip filter; only the ones with data the export carries are
  // applied. Sticker / Poll / Embed / Forward toggles are marked .import-noop
  // in the UI (export has no metadata for those). Mention filters DO work
  // here — Discord stores user mentions inline in `Contents` as `<@id>` (or
  // `<@!id>`), and the literal "@everyone"/"@here" text is preserved too.
  const excludeContent = $("input#excludeSearch").value.trim();
  const excludeMatchMode = $("select#excludeMatchMode").value;
  const excludeLink = $("input#excludeLink").checked;
  const excludeImage = $("input#excludeImage").checked;
  const excludeVideo = $("input#excludeVideo").checked;
  const excludeSound = $("input#excludeSound").checked;
  const excludeMentionsList = parseCsvList($("input#excludeMentionsId").value);
  const excludeMentionEveryone = $("input#excludeMentionEveryone").checked;
  const excludeExtensions = readSkipExtensions();

  // Import-only exclusions: drop entire servers, channels, or DMs-with-users
  // before any other filter runs. Each is a comma-separated snowflake list
  // (server can also be `@me` for "all DMs"). Empty Set = filter is disabled.
  const readIdSet = id => new Set(parseCsvList($(`input#${id}`).value));
  const excludeServersSet = readIdSet("importExcludeServers");
  const excludeChannelsSet = readIdSet("importExcludeChannels");
  const excludeUsersSet = readIdSet("importExcludeUsers");
  // The General "Exclude Channel" list applies here too — it's the same
  // "keep these channels" intent, just authored against live search.
  for (const id of readExcludeChannelList()) excludeChannelsSet.add(id);

  // Type-wide pills — drop every guild message / 1:1 DM / group DM
  // respectively. excludeAllChannels backs the "Exclude group DMs" pill;
  // the option name predates the label.
  const excludeAllServers = $("input#importExcludeAllServers").checked;
  const excludeAllDms = $("input#importExcludeAllDms").checked;
  const excludeAllChannels = $("input#importExcludeAllChannels").checked;

  const noopToggles = [];
  if ($("input#excludeSticker").checked) noopToggles.push("贴纸");
  if ($("input#excludePoll").checked) noopToggles.push("投票");
  if ($("input#excludeEmbed").checked) noopToggles.push("嵌入内容");
  if ($("input#excludeForward").checked) noopToggles.push("转发");
  if (noopToggles.length) {
    log.warn(`导入模式：忽略筛选项（${noopToggles.join("、")}）——Discord 数据导出不包含这些数据。`);
  }

  // Build matchers once (regex compilation per message would be wasteful).
  // contentMatch and extensionMatch share helpers with live-mode. Mention-
  // match stays inline because import mode pulls IDs out of raw message text
  // (`<@id>` / `<@!id>`), while live mode reads them from the structured
  // `msg.mentions` array — different shapes.
  const contentMatch = buildContentMatcher(excludeContent, excludeMatchMode);
  const extensionMatch = buildExtensionMatcher(excludeExtensions);
  let mentionMatch = null;
  if (excludeMentionsList.length) {
    const ids = excludeMentionsList.map(id => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const re = new RegExp(`<@!?(?:${ids})>`);
    mentionMatch = s => re.test(s);
  }

  const { filtered, skipReasons } = applyImportFilters(importedSet.messages, {
    excludeAllServers, excludeAllChannels, excludeAllDms,
    excludeServersSet, excludeChannelsSet, excludeUsersSet,
    minMs, maxMs,
    contentMatch, excludeLink,
    excludeImage, excludeVideo, excludeSound,
    mentionMatch, excludeMentionEveryone,
    extensionMatch,
  });

  if (filtered.length === 0) {
    return log.error(`筛选后导入数据中没有剩余消息（原有 ${importedSet.messages.length} 条）。请调整日期范围或消息范围，或点击“全部时间”。`);
  }

  const deleteDelay = getDelayMs("deleteDelay");
  const streamerMode = $("input#streamerMode").checked;

  currentJobInfo = { i: 1, n: 1 }; // import mode is always single-job
  undiscordCore.resetState();
  // resetOptions() seeds every field from DEFAULT_OPTIONS first; only the
  // import-specific run state is overlaid. The pre-pass loop above already
  // trimmed by every applicable filter, so all post-search filters stay at
  // their default no-op values.
  undiscordCore.resetOptions({
    authToken,
    importSource: new ImportSource(filtered),
    pinnedMode: "include", // export records have no pin metadata; "include" is the no-op
    deleteDelay,
    streamerMode,
    askForConfirmation,
  });

  const skipped = importedSet.messages.length - filtered.length;
  log.info(`导入模式任务：已将 ${filtered.length.toLocaleString()} 条消息加入队列${skipped ? `（跳过 ${skipped.toLocaleString()} 条）` : ""}。`);

  // Breakdown lines — show every category that either (a) caught at least one
  // record, or (b) the user explicitly configured (so a configured-but-zero
  // filter is visible too, confirming "yes, your filter ran and matched 0").
  // Categories that are neither configured nor matched stay hidden.
  const dateConfigured = (minMs > -Infinity) || (maxMs < Infinity);
  const breakdown = [
    ["全部服务器（通配）", skipReasons.allServers, excludeAllServers],
    ["全部单聊私信（通配）", skipReasons.allDms, excludeAllDms],
    ["全部群组私信（通配）", skipReasons.allChannels, excludeAllChannels],
    ["服务器", skipReasons.servers, excludeServersSet.size > 0],
    ["频道", skipReasons.channels, excludeChannelsSet.size > 0],
    ["私信用户", skipReasons.dmUsers, excludeUsersSet.size > 0],
    ["日期或消息范围", skipReasons.dateInterval, dateConfigured],
    ["文本", skipReasons.text, !!contentMatch],
    ["链接", skipReasons.links, excludeLink],
    ["提及", skipReasons.mentions, !!mentionMatch],
    ["@everyone / @here", skipReasons.everyone, excludeMentionEveryone],
    ["附件", skipReasons.attachments, excludeImage || excludeVideo || excludeSound],
    ["扩展名", skipReasons.extensions, !!extensionMatch],
  ].filter(([, count, configured]) => count > 0 || configured);
  if (breakdown.length) {
    log.info("  跳过明细：");
    for (const [label, count] of breakdown) log.info(`    ${label}: ${count.toLocaleString()}`);
  }

  try { await undiscordCore.run(); }
  catch (err) { log.error("核心异常", err); undiscordCore.stop(); }
  finally {
    // Drop the source reference so a subsequent search-mode run starts clean.
    undiscordCore.options.importSource = null;
  }
}

/**
 * Validates every search-mode input the user filled in. Returns one of:
 *   { error: string }                                        — caller logs and aborts
 *   { authorList, excludeMentionsList, minDateUsed, warning? } — all good
 * Bundles the parsed-but-still-needed downstream values into the success path
 * so the orchestrator doesn't re-derive them.
 */
function validateRunInputs(input) {
  const { minId, maxId, authorId, mentions, excludeMentions, excludeChannels, content, excludeContent, minDate, maxDate } = input;

  // Snowflake IDs must be numeric and form a valid range.
  if (minId && !/^\d+$/.test(minId)) return { error: `“晚于此消息 ID”必须是数字形式的 Discord ID，实际输入：“${minId}”` };
  if (maxId && !/^\d+$/.test(maxId)) return { error: `“早于此消息 ID”必须是数字形式的 Discord ID，实际输入：“${maxId}”` };
  if (minId && maxId && BigInt(minId) >= BigInt(maxId)) {
    return { error: "“晚于此消息 ID”必须早于（雪花 ID 更小）“早于此消息 ID”。" };
  }

  // Author IDs may be comma-separated (each one expands the batch). Validate numeric.
  const authorList = parseCsvList(authorId);
  for (const a of authorList) {
    if (!/^\d+$/.test(a)) return { error: `作者 ID 列表包含非数字值：“${a}”` };
  }
  // Include @user is single-value — Discord's `mentions=` query param accepts
  // only one ID per request. Reject if the user typed multiple manually.
  if (mentions && !/^\d+$/.test(mentions)) {
    return { error: "“包含 @用户”必须是单个数字形式的 Discord ID。多个提及只支持在“跳过 @用户”中使用（Discord 搜索 API 一次只能筛选一个提及）。" };
  }
  // Skip @user IS multi-value — applied client-side as a list check.
  const excludeMentionsList = parseCsvList(excludeMentions);
  for (const m of excludeMentionsList) {
    if (!/^\d+$/.test(m)) return { error: `跳过提及的用户 ID 列表包含非数字值：“${m}”` };
  }
  // Exclude Channel keep-list — same numeric check so a stray paste fails
  // loudly here instead of silently matching nothing at run time.
  for (const c of parseCsvList(excludeChannels)) {
    if (!/^\d+$/.test(c)) return { error: `排除频道列表包含非数字值：“${c}”——请填写 Discord 频道/帖子 ID` };
  }

  // Search-filter / Delete-filter overlap checks.
  if (content && excludeContent && content.toLowerCase() === excludeContent.toLowerCase()) {
    return { error: "“包含文本”和“跳过文本”相同——不会匹配到任何消息。请清空其中一项。" };
  }
  if (mentions && excludeMentionsList.includes(mentions)) {
    return { error: `包含 @用户（${mentions}）同时出现在跳过 @用户中——不会匹配到任何消息。请从其中一项移除。` };
  }

  // Datetime validation. Date inputs are live-clamped to Discord's epoch via
  // bindDateClamp() the moment the user commits a value, so by the time we
  // get here, the only remaining work is parse-check, default-empty-min,
  // range-check.
  if (minDate && Number.isNaN(new Date(minDate).getTime())) return { error: "“起始日期”无效，请使用日期选择器重新输入。" };
  if (maxDate && Number.isNaN(new Date(maxDate).getTime())) return { error: "“结束日期”无效，请使用日期选择器重新输入。" };
  const minDateUsed = minDate || DISCORD_EPOCH_LOCAL;
  const minDateMs = new Date(minDateUsed).getTime();
  const maxDateMs = maxDate ? new Date(maxDate).getTime() : null;
  if (maxDateMs !== null && minDateMs >= maxDateMs) {
    return { error: "“起始日期”必须早于“结束日期”。" };
  }

  // Warn (don't error) if both intervals are set — the message-ID range
  // wins, the date range is ignored.
  const warning = ((minId || maxId) && (minDate || maxDate))
    ? "同时设置了消息范围和日期范围——消息范围优先。"
    : null;

  return { authorList, excludeMentionsList, minDateUsed, warning };
}

/** Expands `targets × authorList` into per-job entries. An empty `authorList` means "no author filter" — every author's messages in range — which is passed through as an empty `authorId`. DMs are the exception: Discord won't let you delete other users' DM messages, so a DM target always collapses to one self-author job. Returns `{ jobs, warnings }`. */
function expandJobs(targets, authorList) {
  const jobs = [];
  const warnings = [];
  for (const t of targets) {
    if (t.guildId === "@me") {
      // DMs only ever delete your own messages. An empty list ("all authors")
      // or a list of others both collapse to a single self-author job.
      const selfId = getAuthorId() || "";
      if (authorList.length > 1) {
        warnings.push(`私信 ${t.channelId}：已跳过多作者批量任务——私信只支持本人作者。将使用第一个作者（${authorList[0]}）。`);
      } else if (!authorList.length) {
        warnings.push(`私信 ${t.channelId}：作者 ID 为空，但私信只能删除你自己的消息——已按本人处理。`);
      }
      jobs.push({ ...t, authorId: authorList[0] || selfId });
    } else if (authorList.length > 1) {
      for (const a of authorList) jobs.push({ ...t, authorId: a });
    } else {
      // Empty list → empty authorId → no author filter (all authors).
      jobs.push({ ...t, authorId: authorList[0] || "" });
    }
  }
  return { jobs, warnings };
}

/** Search-mode dispatcher. Reads every form input, validates, parses the queue, expands jobs across (target × author), runs a permission pre-flight, and dispatches into core. The caller (startAction) handles the log-clear and import-mode routing. `askForConfirmation` lets the meta-orchestrator suppress the yes/no prompt for snapshots after the first. */
async function runSearchModeFromForm(authToken, askForConfirmation = true) {
  // Author ID left empty means "no author filter": core.ts issues an unfiltered
  // search (`["author_id", this.options.authorId || undefined]`), so every
  // author's messages in range get deleted. That is the intended power-user
  // path, so we no longer silently substitute your own ID here. The guard is the
  // permission pre-flight (checkBatchPermissions): anyone whose messages you can
  // reach needs "管理消息" over that channel / 子区, and the run aborts without
  // it. The notice itself is deferred to onStart so it lands AFTER the
  // "Started at..." line.
  const authorInput = $("input#authorId");
  if (!authorInput.value.trim()) {
    pendingStartNotice = "作者 ID 为空：不按作者筛选，范围内所有作者的消息都会被删除（需要各目标频道的“管理消息”权限，预检会先替你确认）。";
  }

  // ---- Read every input ----
  const authorId = authorInput.value.trim();
  const excludeNsfw = $("input#excludeNsfw").checked;
  // Search filter — include
  const content = $("input#search").value.trim();
  const hasLink = $("input#hasLink").checked;
  const hasImage = $("input#hasImage").checked;
  const hasVideo = $("input#hasVideo").checked;
  const hasSound = $("input#hasSound").checked;
  const hasSticker = $("input#hasSticker").checked;
  const hasPoll = $("input#hasPoll").checked;
  const hasEmbed = $("input#hasEmbed").checked;
  const hasForward = $("input#hasForward").checked;
  const mentions = $("input#mentionsId").value.trim();
  const mentionEveryone = $("input#mentionEveryone").checked;
  const pinnedMode = $("select#pinnedMode").value;
  // Delete filter — exclude (applied client-side after the search response)
  const excludeContent = $("input#excludeSearch").value.trim();
  const excludeMatchMode = $("select#excludeMatchMode").value;
  const excludeLink = $("input#excludeLink").checked;
  const excludeImage = $("input#excludeImage").checked;
  const excludeVideo = $("input#excludeVideo").checked;
  const excludeSound = $("input#excludeSound").checked;
  const excludeSticker = $("input#excludeSticker").checked;
  const excludePoll = $("input#excludePoll").checked;
  const excludeEmbed = $("input#excludeEmbed").checked;
  const excludeForward = $("input#excludeForward").checked;
  const excludeMentions = $("input#excludeMentionsId").value.trim();
  const excludeMentionEveryone = $("input#excludeMentionEveryone").checked;
  const excludeExtensions = readSkipExtensions();
  // Channels (or threads) this server-wide wipe must leave alone.
  const excludeChannels = readExcludeChannelList();
  // Message-ID interval
  const minId = $("input#minId").value.trim();
  const maxId = $("input#maxId").value.trim();
  // Date interval
  const minDate = $("input#minDate").value.trim();
  const maxDate = $("input#maxDate").value.trim();
  // Pacing knobs (stepper-backed; raw ms lives in dataset)
  const searchDelay = getDelayMs("searchDelay");
  const deleteDelay = getDelayMs("deleteDelay");
  const streamerMode = $("input#streamerMode").checked;

  // ---- Validate ----
  const validation = validateRunInputs({
    minId, maxId, authorId, mentions, excludeMentions, excludeChannels, content, excludeContent, minDate, maxDate,
  });
  if (validation.error) return log.error(validation.error);
  const { authorList, minDateUsed, warning } = validation;
  if (warning) log.warn(warning);

  // ---- Queue ----
  const { targets, orphans } = parseTargets();
  if (!targets.length) return log.error("请填写“服务器 ID”字段！");
  if (orphans) log.warn(`${orphans} 个频道没有所属服务器，将被跳过。频道必须属于某个服务器。`);

  // Contradiction guard: a channel-specific target that is also on the
  // keep-list would delete nothing — every hit is dropped client-side before
  // any delete request is spent. Server-wide targets + keep-list is the
  // intended combination and stays silent.
  if (excludeChannels.length) {
    const keepSet = new Set(excludeChannels);
    for (const t of targets) {
      if (t.channelId && keepSet.has(t.channelId)) {
        log.warn(`目标频道 ${dot(t.channelId)} 同时在“排除频道（保留）”列表中——该目标不会删除任何消息，请从保留列表或队列中移除其一。`);
      }
    }
  }

  const { jobs, warnings } = expandJobs(targets, authorList);
  for (const w of warnings) log.warn(w);

  // Pre-flight permission check: any non-DM job with a non-self author needs
  // Manage Messages or Administrator on its target server. One API call total.
  const ok = await checkBatchPermissions(jobs, authToken);
  if (!ok) return;

  // ---- Run ----
  // Reset to 1/N — runBatch will overwrite via onJob in batch mode; single-job
  // runs leave it alone so the top bar shows "Job 1/1" throughout.
  currentJobInfo = { i: 1, n: jobs.length };
  undiscordCore.resetState();
  undiscordCore.resetOptions({
    authToken,
    authorId,
    excludeNsfw,
    minId: minId || minDateUsed,
    maxId: maxId || maxDate,
    content,
    hasLink, hasImage, hasVideo, hasSound,
    hasSticker, hasPoll, hasEmbed, hasForward,
    mentions, // single ID (validated above)
    mentionEveryone,
    pinnedMode,
    excludeContent, excludeMatchMode,
    excludeLink, excludeImage, excludeVideo, excludeSound,
    excludeSticker, excludePoll, excludeEmbed, excludeForward,
    excludeMentions, // comma-separated string; core parses into a list at filter time
    excludeMentionEveryone,
    excludeExtensions, // dedup'd lowercase array (presets ∪ custom textbox)
    excludeChannels, // CSV of channel / thread IDs to keep untouched
    searchDelay,
    deleteDelay,
    streamerMode,
    askForConfirmation,
  });

  if (jobs.length === 1) {
    undiscordCore.options.guildId = jobs[0].guildId;
    undiscordCore.options.channelId = jobs[0].channelId; // '' = server-wide
    undiscordCore.options.authorId = jobs[0].authorId;
    try { await undiscordCore.run(); }
    catch (err) { log.error("核心异常", err); undiscordCore.stop(); }
  } else {
    try { await undiscordCore.runBatch(jobs); }
    catch (err) { log.error("核心异常", err); }
  }
}

/** Returns true when a snapshot has no targets, no import, and no author. The meta-orchestrator uses this to decide whether to append the current form as a trailing snapshot — a blank form after queued batches just runs the queue without a phantom empty pass at the end. */
function isSnapshotBlank(snap) {
  if (snap.importedSet) return false;
  if (snap.guildId.trim() || snap.channelId.trim()) return false;
  if (snap.authorId) return false;
  return true;
}

/** Click handler for the Batch Selection sidebar button. Snapshots the current form, validates it, runs the pre-flight permission check (when a non-self author is present), pushes the snapshot onto selectionQueue, and resets the form. Failures abort without queuing — the user gets an explicit log line instead of silently building a poisoned queue. */
async function queueSelectionAction() {
  const snap = captureSnapshot();
  if (isSnapshotBlank(snap)) {
    return log.warn("批量选择：没有可加入队列的内容——请先设置目标、作者或导入数据。");
  }

  // Dedup — if an exact-match snapshot is already queued, refuse rather than
  // silently double-queue. Compares every captured field; importedSet by
  // identity so two snapshots over the same loaded import collide as expected.
  const newKey = snapshotKey(snap);
  const dupeIdx = selectionQueue.findIndex(s => snapshotKey(s) === newKey);
  if (dupeIdx !== -1) {
    return log.warn(`批量选择：当前选择与已排队的第 ${dupeIdx + 1} 个快照完全相同，不再重复加入。`);
  }

  // Soft redundancy warning — fires when one snapshot fully subsumes the
  // other. Never blocks; the worst case is harmless 404s on already-deleted
  // messages, and finer-grained policing isn't ours to do.
  for (let i = 0; i < selectionQueue.length; i++) {
    const prior = selectionQueue[i];
    if (snapshotASubsumesB(prior, snap)) {
      log.warn(`批量选择：已排队的第 ${i + 1} 个快照已经覆盖当前选择的全部目标。仍将加入队列——本次任务可能主要因消息已删除而返回 404。`);
    } else if (snapshotASubsumesB(snap, prior)) {
      log.warn(`批量选择：当前选择覆盖已排队的第 ${i + 1} 个快照的全部范围。仍将加入队列——第 ${i + 1} 个快照会先运行，当前选择随后会重复处理相同范围并产生 404。`);
    }
  }

  // Import mode: validate the date / message-ID bounds in the same shape
  // runImportModeFromForm does. No pre-flight — deletion runs against the
  // user's own export only.
  if (snap.importedSet) {
    const { minId, maxId, minDate, maxDate } = snap;
    if (minId && !/^\d+$/.test(minId)) return log.error(`批量选择：“晚于此消息 ID”必须是数字，实际输入“${minId}”`);
    if (maxId && !/^\d+$/.test(maxId)) return log.error(`批量选择：“早于此消息 ID”必须是数字，实际输入“${maxId}”`);
    if (minId && maxId && BigInt(minId) >= BigInt(maxId)) {
      return log.error("批量选择：“晚于此消息 ID”必须早于“早于此消息 ID”。");
    }
    if (minDate && Number.isNaN(new Date(minDate).getTime())) return log.error("批量选择：“起始日期”无效。");
    if (maxDate && Number.isNaN(new Date(maxDate).getTime())) return log.error("批量选择：“结束日期”无效。");

    selectionQueue.push(snap);
    renderQueueBadge();
    log.info(`已加入第 ${selectionQueue.length} 个选择快照（导入模式）。`);
    resetAllSelection();
    return;
  }

  // Search-mode snapshots: full validation + pre-flight.
  const validation = validateRunInputs({
    minId:           snap.minId,
    maxId:           snap.maxId,
    authorId:        snap.authorId,
    mentions:        snap.mentionsId,
    excludeMentions: snap.excludeMentionsId,
    content:         snap.content,
    excludeContent:  snap.excludeSearch,
    minDate:         snap.minDate,
    maxDate:         snap.maxDate,
  });
  if (validation.error) return log.error(`批量选择：${validation.error}`);

  const authToken = fillToken();
  if (!authToken) return;

  // parseTargets reads the live form. captureSnapshot ran milliseconds ago
  // against the same fields, so the values match the snapshot we're queuing.
  const { targets } = parseTargets();
  if (!targets.length) return log.error("批量选择：队列为空——请先添加服务器、频道或私信。");

  // Empty Author ID = no author filter (all authors) — same as startAction.
  const { authorList } = validation;
  const { jobs } = expandJobs(targets, authorList);

  const ok = await checkBatchPermissions(jobs, authToken);
  if (!ok) {
    log.error("批量选择：快照被拒绝——预检权限检查失败（见上方日志），未加入队列。");
    return;
  }

  selectionQueue.push(snap);
  renderQueueBadge();
  log.info(`已加入第 ${selectionQueue.length} 个选择快照——已准备 ${jobs.length} 个任务。`);
  resetAllSelection();
}

/** Meta-orchestrator wired to the ▶︎ Delete button. Builds the list of snapshots to run (queued first, current form last unless it's blank), then iterates and dispatches each via runSearchModeFromForm or runImportModeFromForm. Each dispatch is independent — core.resetState/resetOptions per call prevents state bleed. The selectionQueue drains when the meta-batch finishes (or stops mid-way) so subsequent runs start clean. */
async function startAction() {
  if (undiscordCore.state.running) return log.warn("已有任务正在运行。");

  // Crash-safe persistence: the form as launched is what the next session
  // restores, even if the tab dies mid-run.
  persistSettings();

  const authToken = fillToken();
  if (!authToken) return;

  const snapshots = [...selectionQueue];
  const currentSnap = captureSnapshot();
  if (!isSnapshotBlank(currentSnap)) snapshots.push(currentSnap);

  if (snapshots.length === 0) {
    return log.error("没有可运行的任务——请先设置选择，或先加入一个批量选择。");
  }

  ui.logArea.innerHTML = "";

  const total = snapshots.length;
  if (total > 1) log.info(`批量任务组：将依次运行 ${total} 个选择。`);

  // Confirmation prompt fires only on the first selection. The user already
  // confirmed the intent of running the queued batches when they hit Delete;
  // re-prompting between snapshots would just train them to click "Yes" without
  // reading. Declining the first prompt aborts the entire meta-batch.
  let confirmationConsumed = false;

  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];
    if (total > 1) log.info(`══════ 选择 ${i + 1}/${total} ══════`);

    // Replay into the live form so the dispatchers (which read from form
    // elements) see the snapshot's values. Restore importedSet too, since
    // mode dispatch is keyed off it.
    applySnapshot(snap);
    importedSet = snap.importedSet;
    if (importedSet) {
      ui.undiscordWindow.classList.add("import-mode");
      $("#importBadge").style.display = "inline-flex";
    } else {
      ui.undiscordWindow.classList.remove("import-mode");
      $("#importBadge").style.display = "none";
    }
    renderImportSummary();

    const askForConfirmation = !confirmationConsumed;
    if (importedSet) await runImportModeFromForm(authToken, askForConfirmation);
    else await runSearchModeFromForm(authToken, askForConfirmation);

    // user-declined (first prompt) and user-stopped (Stop mid-run) both
    // abort the remaining meta-batch — barging on after either would betray
    // the user's intent.
    if (undiscordCore.state.endReason === "user-declined") {
      if (i < snapshots.length - 1) {
        log.warn(`批量任务组已在选择 ${i + 1}/${total} 处中止——剩余 ${total - i - 1} 个选择已跳过（你拒绝了确认提示）。`);
      }
      break;
    }
    if (undiscordCore.state.endReason === "user-stopped" && i < snapshots.length - 1) {
      log.warn(`批量任务组已在选择 ${i + 1}/${total} 处停止——剩余 ${total - i - 1} 个选择已跳过。`);
      break;
    }

    confirmationConsumed = true;
  }

  selectionQueue = [];
  renderQueueBadge();
  if (total > 1) log.info("批量任务组已完成。");
}

/** Click handler for the 🛑 Stop button. Forwards to core.stop(). */
function stopAction() {
  undiscordCore.stop();
}


/** Open/close the panel from outside (plugin command). Returns false when the panel isn't mounted. */
export function togglePanel(): boolean {
  if (!toggleWindowRef) return false;
  toggleWindowRef();
  return true;
}

export default initUI;
