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
// GENERAL UTILITIES
// ----------------------------------------------------------------------------
// Pure functions for parsing user input, building filter predicates, and
// formatting display strings. No DOM access; no module state.
// ============================================================================

/** Splits a comma-separated string into a trimmed array with empty fragments dropped. Returns [] for null/undefined/empty input. */
function parseCsvList(str) {
  if (str == null) return [];
  const s = String(str).trim();
  if (!s) return [];
  return s.split(/\s*,\s*/).filter(Boolean);
}

/** Returns a `(content) => boolean` predicate matching `term` either as a case-insensitive substring (default) or as a standalone word ('exact' mode). Returns null when `term` is empty. */
function buildContentMatcher(term, mode) {
  if (!term) return null;
  if (mode === "exact") {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    return s => re.test(s || "");
  }
  const lower = term.toLowerCase();
  return s => (s || "").toLowerCase().includes(lower);
}

/** Returns an `(attachments) => boolean` predicate that's true when any attachment's filename or URL ends with one of the listed extensions. Returns null when the list is empty. */
function buildExtensionMatcher(extensions) {
  if (!extensions?.length) return null;
  const set = new Set(extensions);
  return attachments => !!attachments?.some(a => {
    const name = a.filename || a.url || "";
    const m = name.toLowerCase().match(/\.([a-z0-9]+)(?:[?#]|$)/);
    return m && set.has(m[1]);
  });
}

/** Formats a millisecond duration as a "Xh Ym Zs" string. */
const msToHMS = s => `${s / 3.6e6 | 0}h ${(s % 3.6e6) / 6e4 | 0}m ${(s % 6e4) / 1000 | 0}s`;

/** HTML-escapes a value (& < " ') for safe injection into innerHTML. */
const escapeHTML = html => String(html).replace(/[&<"']/g, m => ({ "&": "&amp;", "<": "&lt;", '"': "&quot;", "'": "&#039;" })[m]);

/** Emits the `.sm-real / .sm-redacted` dual-span used by streamer-mode log redaction. CSS at panel scope shows exactly one of the two spans depending on whether `.streamer-on` is set, so toggling streamer mode instantly re-renders every already-printed log line. The real value is HTML-escaped; the placeholder defaults to '••••' (callers pass e.g. '[ATTACHMENTS]' for non-ID redactions). */
function redactHtml(real, placeholder = "••••") {
  return `<span class="sm-real">${escapeHTML(String(real))}</span><span class="sm-redacted">${escapeHTML(placeholder)}</span>`;
}

/** Joins a `[[key, value], ...]` array into a URL query string, skipping pairs whose value is undefined. Values are URL-encoded. */
const queryString = params => params.filter(p => p[1] !== undefined).map(p => p[0] + "=" + encodeURIComponent(p[1])).join("&");

/** Async window.confirm() — yields one event-loop tick so queued log writes can paint before the modal blocks the thread. */
const askYesNo = async msg => new Promise(resolve => setTimeout(() => resolve(window.confirm(msg)), 10));

/** Converts a datetime-local string ("YYYY-MM-DDTHH:MM") to a Discord snowflake ID. Plain numeric strings pass through unchanged. Pre-epoch values clamp to 0. */
const toSnowflake = date => {
  if (!/:/.test(date)) return date;
  const offset = new Date(date).getTime() - 1420070400000;
  return Math.max(0, offset) * Math.pow(2, 22);
};

/** Inverse of toSnowflake — returns the millisecond Unix timestamp embedded in a Discord snowflake. BigInt avoids precision loss on the 64-bit ID. */
const snowflakeToMs = sn => Number((BigInt(sn) >> 22n) + 1420070400000n);


// ============================================================================
// DOM HELPERS
// ----------------------------------------------------------------------------
// Thin wrappers around DOM construction primitives.
// ============================================================================

/** Parses an HTML fragment string into a single root element and returns it. */
function createElm(html) {
  const temp = document.createElement("div");
  temp.innerHTML = html;
  return temp.removeChild(temp.firstElementChild);
}

/** Appends a `<style>` element with the given CSS to `<head>` and returns the element. */
function insertCss(css) {
  const style = document.createElement("style");
  style.appendChild(document.createTextNode(css));
  document.head.appendChild(style);
  return style;
}


// ============================================================================
// LOG FACADE
// ----------------------------------------------------------------------------
// Six log levels routed through a single setLogFn() target. Until a target is
// registered, each level falls through to the matching console.* method so
// errors during early initialisation still reach the devtools console.
// ============================================================================

let logFn;

/** Registers the function that receives every subsequent log call. */
const setLogFn = fn => logFn = fn;

const log = {
  debug(...args) { return logFn ? logFn("debug", args) : console.debug(...args); },
  info(...args) { return logFn ? logFn("info", args) : console.info(...args); },
  verb(...args) { return logFn ? logFn("verb", args) : console.log(...args); },
  warn(...args) { return logFn ? logFn("warn", args) : console.warn(...args); },
  error(...args) { return logFn ? logFn("error", args) : console.error(...args); },
  success(...args) { return logFn ? logFn("success", args) : console.info(...args); },
};


// ============================================================================
// DISCORD ID / TOKEN EXTRACTORS
// ----------------------------------------------------------------------------
// Reads the auth token, current user ID, and current guild/channel IDs from
// Discord's own runtime state — localStorage for credentials, URL parsing for
// channel context.
//
// Discord URL shapes recognised:
//   /channels/<guildId>/<channelId>  — inside a guild text/voice channel
//   /channels/@me/<channelId>        — inside an open DM or group DM
//   /channels/@me                    — friends tab (DM list, no channel selected)
// ============================================================================

// ---- Vencord adapter: the userscript's iframe-localStorage gymnastics existed
// only because userscript worlds are storage-isolated. Vencord itself routes
// storage the same way (`const { localStorage } = window` in @utils/localStorage):
// the renderer bundle's global scope is not the Window, so bare `localStorage`
// throws ReferenceError while window's binding works. The beforeunload flush and
// the JSON parse keep the userscript's exact semantics. ----
import { localStorage } from "@utils/localStorage";
import { findByPropsLazy } from "@webpack";
import { AuthenticationStore, ChannelStore, PermissionsBits, PermissionStore, UserStore } from "@webpack/common";

/** Reads one key from localStorage. Returns null on any failure — persistence is best-effort and must never block the panel. */
function readLocalStorage(key) {
  try { return localStorage.getItem(key); }
  catch (err) { return null; }
}

/** Writes one key to localStorage. Best-effort: a blocked or full storage silently skips the save. */
function writeLocalStorage(key, value) {
  try { localStorage.setItem(key, value); }
  catch (err) { /* storage unavailable — settings just won't persist */ }
}

const CHANNEL_URL_RE = /channels\/([\w@]+)(?:\/(\d+))?/;

let tokenSource = "尚未读取";

/** Returns the Discord auth token: live from the auth store when it offers one, else the userscript's localStorage read after nudging Discord to flush its in-memory cache. */
function getToken() {
  try {
    const live = AuthenticationStore?.getToken?.();
    if (live) { tokenSource = "AuthenticationStore"; return live; }
  } catch (err) { /* fall through to the storage read */ }
  tokenSource = "localStorage 回退";
  window.dispatchEvent(new Event("beforeunload"));
  return JSON.parse(localStorage.token);
}

/**
 * One authenticated GET, so a failing plugin can be diagnosed in one line:
 * a bad token, a rejected request shape, or a network wall each read differently.
 * Runs at plugin start and stays quiet unless it does not come back 200.
 */
async function probeAuth() {
  let token;
  try { token = getToken(); }
  catch (err) { return `令牌读取抛错：${err}`; }
  if (!token) return "令牌为空";

  const headers = authHeaders(token);
  const marks = `${headers["X-Super-Properties"] ? "X-Super-Properties✓" : "X-Super-Properties✗"} ${headers["X-Fingerprint"] ? "X-Fingerprint✓" : "X-Fingerprint✗"}`;

  try {
    const resp = await fetch("https://discord.com/api/v9/users/@me", { headers });
    const body = resp.ok ? "" : `，返回体 ${(await resp.text()).slice(0, 200)}`;
    return `GET /users/@me → ${resp.status}${body}（令牌来源 ${tokenSource}，长度 ${String(token).length}，${marks}）`;
  } catch (err) {
    return `GET /users/@me 抛错：${err}（令牌来源 ${tokenSource}，${marks}）`;
  }
}

/** Returns the current user's snowflake ID from the live user store. */
function getAuthorId() {
  return UserStore.getCurrentUser()?.id ?? null;
}

// ---- Channel-level permission probe ----------------------------------------
// The server-level permission bitfield is only the outer gate: a single channel
// or thread (子区) can deny Manage Messages on its own through overwrites, and
// that only shows up as a wall of 403s once the run is already deleting. This
// asks the client's own permission store instead — same source Discord uses for
// the UI, no extra request — and it resolves threads through their parent
// channel, which is exactly how the permission is granted there.
//
// Returns `true` / `false`, or `null` when it cannot tell (hand-typed ID for a
// channel that isn't loaded, store not ready). `null` means "do not judge":
// the caller falls back to the server-level answer rather than blocking a run
// on a question this probe could not see.
function canManageMessages(channelId) {
  if (!channelId) return null;
  let channel;
  try { channel = ChannelStore.getChannel(channelId); }
  catch (err) { return null; }
  if (!channel) return null;
  try { return PermissionStore.can(PermissionsBits.MANAGE_MESSAGES, channel); }
  catch (err) { return null; }
}

// ---- Discord client headers -------------------------------------------------
// Discord now rejects user-token API calls that carry only `Authorization`: the
// search endpoint answers `401 Unauthorized` to a bare token, and the delete
// endpoint sits behind the same gate (upstream undiscord issue #806). Its own
// HTTP layer always sends `X-Super-Properties` (and a fingerprint when it has
// one), so both are read from the client itself here — a hand-built copy would
// go stale on the next Discord update, which is exactly what broke this.
const superPropertiesModule = findByPropsLazy("getSuperPropertiesBase64");
const legacySuperPropertiesModule = findByPropsLazy("getSuperProperties");

/** Discord's own base64 super-properties blob, falling back to a client-shaped one when the module isn't loaded. */
function superPropertiesHeader() {
  try {
    const base64 = superPropertiesModule?.getSuperPropertiesBase64?.();
    if (typeof base64 === "string" && base64) return base64;
  } catch (err) { /* module not in the registry yet — try the next source */ }
  try {
    const props = legacySuperPropertiesModule?.getSuperProperties?.();
    if (props) return btoa(JSON.stringify(props));
  } catch (err) { /* same — fall back to a synthetic blob */ }
  try {
    const ua = navigator.userAgent;
    return btoa(JSON.stringify({
      os: "Windows",
      browser: "Chrome",
      device: "",
      system_locale: navigator.language || "en-US",
      browser_user_agent: ua,
      browser_version: ua.match(/Chrome\/([\d.]+)/)?.[1] ?? "120.0.0",
      os_version: "10",
      release_channel: "stable",
      client_build_number: 9999,
      client_event_source: null,
    }));
  } catch (err) {
    return null;
  }
}

/** Headers for every Discord API call this plugin makes: the token plus the client headers Discord now demands. */
function authHeaders(token = getToken()) {
  const headers = { "Authorization": token };
  const superProperties = superPropertiesHeader();
  if (superProperties) headers["X-Super-Properties"] = superProperties;
  try {
    const fingerprint = AuthenticationStore?.getFingerprint?.();
    if (fingerprint) headers["X-Fingerprint"] = fingerprint;
  } catch (err) { /* fingerprint is optional — the request still carries the two required headers */ }
  return headers;
}

/** Returns the current guild ID from the URL, or '@me' on the friends tab. Alerts and returns null when no channel/server context can be parsed. */
function getGuildId() {
  const m = location.href.match(CHANNEL_URL_RE);
  if (m) return m[1];
  alert("无法找到服务器 ID！\n请先打开一个服务器或私信频道。");
  return null;
}

/** Returns the current channel ID from the URL. Alerts and returns null when no channel is open. */
function getChannelId() {
  const m = location.href.match(CHANNEL_URL_RE);
  if (m && m[2]) return m[2];
  alert("无法找到频道 ID！\n请先打开一个频道或私信。");
  return null;
}

/** Returns the Discord auth token, or '' on failure (with an error logged). */
function fillToken() {
  try {
    return getToken();
  } catch (err) {
    log.verb(err);
    log.error("无法自动检测授权令牌！");
    log.info("请确认 Undiscord Lite 已是最新版本。");
  }
  return "";
}

/**
 * Every ID a channel answers to for the auto-flush channel layer: itself, plus
 * its parent when it is a thread or forum post — so listing (or keeping) a forum
 * channel covers the posts inside it, and vice versa. Shared by the auto-flush
 * scheduler and the right-click menu so the two can never disagree about what a
 * channel "is".
 */
function channelCandidates(channelId: string) {
  const ids = [channelId];
  try {
    const parent = ChannelStore.getChannel(channelId)?.parent_id;
    if (parent) ids.push(parent);
  } catch { /* channel store unavailable — fall back to the bare ID */ }
  return ids;
}

export { askYesNo, authHeaders, buildContentMatcher, buildExtensionMatcher, canManageMessages, channelCandidates, createElm, escapeHTML, fillToken, getAuthorId, getChannelId, getGuildId, getToken, insertCss, log, msToHMS, parseCsvList, probeAuth, queryString, readLocalStorage, redactHtml, setLogFn, snowflakeToMs, toSnowflake, writeLocalStorage };

