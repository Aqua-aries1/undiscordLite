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
// DISCORD DATA-EXPORT IMPORT
// ----------------------------------------------------------------------------
// Parses the contents of an unzipped Discord data export's `messages/` folder
// into a flat list of (channelId, messageId, ...) records, and exposes an
// `ImportSource` that the run loop consumes in place of Discord's search API.
// All parsing is local — no network access in this module.
//
// Folder shape (post-extraction):
//   messages/
//     index.json              — { "<channelId>": "<display string>", ... }   (optional)
//                               Display string is "<channel> in <guild>" for guild
//                               channels and "Direct Message with <user>#<discriminator>"
//                               for DMs. The DM string is the only place the friend's
//                               username appears — channel.json's recipients carries IDs only.
//     c<channelId>/
//       channel.json          — channel metadata (optional but preferred)
//       messages.json         — array of { ID, Timestamp, Contents, Attachments }
//
// Both letter-cases are tolerated for message field names (`ID`/`id`,
// `Contents`/`content`, etc.) since Discord's exporter has shipped both.
// ============================================================================

/** Walks a list of `File` objects (from `<input webkitdirectory>` or `multiple`) and returns `{ messages, channelCount, oldestTs, newestTs }`. Throws on hard parse failures (bad JSON, no c<id>/ folders found); per-channel issues that don't invalidate the rest are skipped silently. */
async function parseExport(fileList) {
  const files = Array.from(fileList);
  if (files.length === 0) {
    throw new Error("未选择文件。");
  }

  // Top-level index.json maps channel ID → human-readable name. Optional —
  // falls back to channel.json's `name`, then a "c<id>" stub.
  const indexFile = files.find(f => /(^|\/)index\.json$/i.test(relPath(f)));
  let nameIndex = {};
  if (indexFile) {
    try { nameIndex = JSON.parse(await indexFile.text()); }
    catch { /* malformed index — channel.json fallback still works */ }
  }

  // Group files by their c<channelId> parent folder.
  const folderRe = /(?:^|\/)c(\d+)\/[^/]+$/;
  const channelFiles = new Map(); // channelId -> { messages?: File, channel?: File }
  for (const f of files) {
    const m = relPath(f).match(folderRe);
    if (!m) continue;
    const channelId = m[1];
    if (!channelFiles.has(channelId)) channelFiles.set(channelId, {});
    const slot = channelFiles.get(channelId);
    if (/messages\.json$/i.test(f.name)) slot.messages = f;
    else if (/channel\.json$/i.test(f.name)) slot.channel = f;
  }

  if (channelFiles.size === 0) {
    throw new Error("未找到 c<channelId>/ 文件夹。请选择 Discord 数据导出文件中解压后的“messages/”文件夹。");
  }

  const allMessages = [];
  let parsedChannels = 0;
  let oldestTs = Infinity, newestTs = -Infinity;

  for (const [channelId, slot] of channelFiles) {
    if (!slot.messages) continue; // bare folder with no messages.json

    let channelMeta = {};
    if (slot.channel) {
      try { channelMeta = JSON.parse(await slot.channel.text()); }
      catch { /* missing/malformed channel.json — fall through to nameIndex */ }
    }
    // Discord export channel.json shapes (verified against late-2025 exports):
    //   GUILD_TEXT : { id, type:"GUILD_TEXT", name, guild:{ id, name } }
    //   DM         : { id, type:"DM", recipients:[<userId>, <userId>] }   — usernames live in index.json only
    //   GROUP_DM   : { id, type:"GROUP_DM", recipients:[...], name? }     — name only when user-set
    //   THREAD     : type "GUILD_PUBLIC_THREAD" / similar; treated as guild for grouping
    const type = channelMeta.type || "UNKNOWN";
    const channelName = channelMeta.name || nameIndex[channelId] || `c${channelId}`;
    const guildId = channelMeta.guild?.id || null;
    const guildName = channelMeta.guild?.name || null;
    // DMs carry no username inside channel.json — only user IDs. The friend's
    // display name comes from index.json's "Direct Message with NAME#0" string.
    // Group DMs may have a user-set `name` (or null when unnamed).
    const dmFriendName = (type === "DM") ? extractDmFriendName(nameIndex[channelId]) : null;
    const recipientIds = Array.isArray(channelMeta.recipients) ? channelMeta.recipients.map(String) : [];
    const recipientCount = recipientIds.length;

    let raw;
    try { raw = JSON.parse(await slot.messages.text()); }
    catch (e) {
      throw new Error(`解析 ${relPath(slot.messages)} 失败：${e.message}`);
    }
    if (!Array.isArray(raw)) {
      throw new Error(`${relPath(slot.messages)} 不包含 JSON 数组。`);
    }

    parsedChannels++;
    for (const m of raw) {
      const messageId = m.ID ?? m.id;
      const timestamp = normalizeExportTs(m.Timestamp ?? m.timestamp);
      const content = m.Contents ?? m.content ?? "";
      const attachRaw = m.Attachments ?? m.attachments ?? "";

      if (!messageId) continue; // can't delete without an ID

      const ts = new Date(timestamp).getTime();
      if (Number.isFinite(ts)) {
        if (ts < oldestTs) oldestTs = ts;
        if (ts > newestTs) newestTs = ts;
      }

      allMessages.push({
        channelId,
        guildId,
        guildName,
        channelName,
        type,
        dmFriendName,
        recipientCount,
        recipientIds,
        messageId: String(messageId),
        timestamp,
        content,
        attachments: parseAttachments(attachRaw),
      });
    }
  }

  return {
    messages: allMessages,
    channelCount: parsedChannels,
    oldestTs: oldestTs === Infinity ? null : oldestTs,
    newestTs: newestTs === -Infinity ? null : newestTs,
  };
}

/** Returns a file's path relative to the picked folder root. Falls back to `name` when the picker doesn't expose `webkitRelativePath` (plain `multiple` selection). */
function relPath(file) {
  return file.webkitRelativePath || file.name;
}

/** Normalises a Discord export timestamp to ISO-with-Z form. Discord exports timestamps as "YYYY-MM-DD HH:MM:SS" UTC; plain `new Date()` parses that as LOCAL time, shifting every imported timestamp by the user's TZ offset. Already-ISO inputs (with T separator, trailing Z, or numeric offset) pass through unchanged. */
function normalizeExportTs(str) {
  if (!str || typeof str !== "string") return str;
  if (/T/.test(str) || /Z$/.test(str) || /[+-]\d\d:?\d\d$/.test(str)) return str;
  return str.replace(" ", "T") + "Z";
}

/** Pulls the friend's username out of an index.json DM display string ("Direct Message with USER#0"). Returns null when the entry is missing or doesn't match the expected prefix. */
function extractDmFriendName(indexValue) {
  if (typeof indexValue !== "string") return null;
  const m = indexValue.match(/^Direct Message with (.+?)(?:#\d+)?$/);
  return m ? m[1] : null;
}

/**
 * Builds a per-guild / per-DM breakdown of an imported set, returned as an
 * array of pre-formatted log lines. Sorted by message count (desc) within
 * each group so the heaviest sources surface first.
 *
 * `redactName` is invoked on every server / DM / group display name before it
 * lands in a line — caller wires it to the streamer-mode toggle so sensitive
 * names get dotted out without summarizeImport itself depending on UI state.
 *
 * Output shape:
 *   "Server: <name> | Channels: <N> | Messages: <total>"
 *   "DM:     <friend>                | Messages: <total>"
 *   "Group DM: <name or count>       | Messages: <total>"
 *   "Unknown channel kind: <N>       | Messages: <total>"   (channel.json missing)
 */
function summarizeImport(parsed, redactName = v => v) {
  const guilds = new Map(); // guildId -> { name, channels:Set<channelId>, count }
  const dms = new Map(); // channelId -> { friend, count }
  const groups = new Map(); // channelId -> { name, recipientCount, count }
  const unknown = new Map(); // channelId -> count

  for (const m of parsed.messages) {
    if (m.type === "GUILD_TEXT" || (m.guildId && m.type !== "DM" && m.type !== "GROUP_DM")) {
      // Threads, voice text, announcements, etc. roll up under their parent guild.
      const key = m.guildId || `unknown-guild-for-${m.channelId}`;
      if (!guilds.has(key)) guilds.set(key, { name: m.guildName || "未知服务器", channels: new Set(), count: 0 });
      const g = guilds.get(key);
      g.channels.add(m.channelId);
      g.count++;
      if (!g.name && m.guildName) g.name = m.guildName;
    } else if (m.type === "DM") {
      if (!dms.has(m.channelId)) dms.set(m.channelId, { friend: m.dmFriendName || `（未知——${m.channelId}）`, count: 0 });
      dms.get(m.channelId).count++;
    } else if (m.type === "GROUP_DM") {
      if (!groups.has(m.channelId)) groups.set(m.channelId, { name: m.channelName, recipientCount: m.recipientCount, count: 0 });
      groups.get(m.channelId).count++;
    } else {
      if (!unknown.has(m.channelId)) unknown.set(m.channelId, 0);
      unknown.set(m.channelId, unknown.get(m.channelId) + 1);
    }
  }

  const lines = [];

  const sortedGuilds = [...guilds.values()].sort((a, b) => b.count - a.count);
  for (const g of sortedGuilds) {
    lines.push(`服务器：${redactName(g.name)} | 频道：${g.channels.size} | 消息：${g.count.toLocaleString()}`);
  }

  const sortedDms = [...dms.values()].sort((a, b) => b.count - a.count);
  for (const d of sortedDms) {
    lines.push(`私信：${redactName(d.friend)} | 消息：${d.count.toLocaleString()}`);
  }

  const sortedGroups = [...groups.values()].sort((a, b) => b.count - a.count);
  for (const g of sortedGroups) {
    const label = g.name || `群组私信（${g.recipientCount} 人）`;
    lines.push(`群组私信：${redactName(label)} | 消息：${g.count.toLocaleString()}`);
  }

  if (unknown.size) {
    const total = [...unknown.values()].reduce((s, n) => s + n, 0);
    lines.push(`未知频道类型：${unknown.size} 个频道 | 消息：${total.toLocaleString()}`);
  }

  return lines;
}

/** Parses Discord's whitespace/comma-separated Attachment URL list into the `[{url, content_type}, ...]` shape filterResponse expects. content_type is inferred from the URL extension. */
function parseAttachments(raw) {
  if (!raw) return [];
  const urls = String(raw).split(/[\s,]+/).filter(Boolean);
  return urls.map(url => ({ url, content_type: inferContentType(url) }));
}

/** Returns the inferred MIME type for a URL based on its extension. Falls back to 'application/octet-stream' for unknown extensions. */
function inferContentType(url) {
  const ext = (url.toLowerCase().match(/\.([a-z0-9]+)(?:\?|$)/) || [])[1];
  if (!ext) return "application/octet-stream";
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"].includes(ext)) return `image/${ext}`;
  if (["mp4", "mov", "webm", "mkv", "avi"].includes(ext)) return `video/${ext}`;
  if (["mp3", "wav", "ogg", "flac", "m4a", "opus"].includes(ext)) return `audio/${ext}`;
  return "application/octet-stream";
}


// ============================================================================
// IMPORT SOURCE
// ----------------------------------------------------------------------------
// Drop-in replacement for the search() side of the run loop. Holds the parsed
// message list and a cursor; each fetchPage(core) call assigns the next slice
// into core.state._searchResponse using the same shape Discord's search API
// returns, so filterResponse() works unchanged.
// ============================================================================

/** Pages an in-memory message list into core.state._searchResponse, mimicking the shape of Discord's search API so the rest of the run loop is mode-agnostic. */
class ImportSource {
  static PAGE_SIZE = 50;

  constructor(messages) {
    this.messages = messages;
    this.cursor = 0;
  }

  /** True once every imported record has been emitted. Lets the run loop short-circuit the empty-page-retry budget — no search index to wait on in import mode. */
  get exhausted() {
    return this.cursor >= this.messages.length;
  }

  /** Populates core.state._searchResponse with the next page of messages. Each message is wrapped in a single-element conversation array with hit:true to match Discord's `messages: [[{hit, ...}, ...]]` shape. */
  fetchPage(core) {
    const slice = this.messages.slice(this.cursor, this.cursor + ImportSource.PAGE_SIZE);
    this.cursor += slice.length;
    core.state._searchResponse = {
      total_results: this.messages.length,
      messages: slice.map(m => [toApiShape(m)]),
    };
  }
}

/** Builds a Discord-API-shaped message object from an export record. Fields the export doesn't carry (mentions, embeds, author info) are stubbed with safe defaults that filterResponse's exclude-* paths gracefully ignore. */
function toApiShape(m) {
  return {
    hit: true,
    id: m.messageId,
    channel_id: m.channelId,
    type: 0, // regular user message — passes filterResponse's type filter
    pinned: false,
    content: m.content || "",
    timestamp: m.timestamp,
    attachments: m.attachments || [],
    mentions: [],
    mention_everyone: false,
    embeds: [],
    author: { username: "imported", discriminator: "0" },
  };
}

export { ImportSource,parseExport, summarizeImport };

