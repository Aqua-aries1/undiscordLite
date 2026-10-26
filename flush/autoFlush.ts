/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Auto-flush: delete my own messages once they get old.
// ------------------------------------------------------
// While enabled in the plugin settings, every message authored by me — sent
// from this client or synced from other devices — is scheduled for deletion
// `autoFlushDelay` seconds after it was sent. Scheduling is driven by
// MESSAGE_CREATE; the actual DELETE is gated on the message's state at fire
// time so a still SENDING/FAILED (or already vanished) message is waited on /
// skipped instead of firing a doomed request. Timers die with the plugin
// (stop()) and with the setting being switched off.
//
// The delete moment is always `message timestamp + delay`. There is no
// countdown footnote anymore — the old AI-flavoured stats line, its `:R`
// timestamp and the engine/TPS knobs that fed it are gone.
// Anchoring on the message timestamp (not the moment the event arrived) still
// makes a message sent from a phone, arriving late through channel sync, land on
// the schedule it would have had if this client had been sending.
//
// Scope: two layers, composed in scope.ts's `channelInFlushScope`. The server
// layer is a whitelist/blacklist pair ("@me" = DMs); the channel layer's
// whitelist is an OPT-IN that overrides the server layer, so a single channel
// can be pulled into auto-flush inside an otherwise-excluded server. The check
// runs at schedule time (and again on resume, against the current settings).
//
// Deliberate limits: nothing sent before Discord started (a start-slack window
// guards against channel-sync replays), and pinned or otherwise undeletable
// messages just log a failure.

import { ChannelStore, FluxDispatcher, MessageStore, UserStore } from "@webpack/common";

import { authHeaders, channelCandidates, getToken, readLocalStorage, writeLocalStorage } from "../engine/helpers";
import { channelInFlushScope, clampDelaySec, parseDelayMap, parseIdList, resolveDelaySec } from "./scope";

const API_BASE = "https://discord.com/api/v9";
const RETRY_MS = 1500; // re-arm interval while a message is still sending
const MAX_TRIES = 20; // ≈30 s of waiting on a stuck SENDING state (and the same budget for transient DELETE failures), then give up
const RETRY_AFTER_MS = 30000; // spacing for a DELETE that failed for a reason that may pass (network, 5xx, 429)
// A delete promise made before a restart is still honored on the next start if
// it is at most this old. Older than this and the queue is just stale —
// re-firing it would delete things nobody remembers.
const RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PENDING_KEY = "UndiscordLite-pendingFlush";

interface FlushConfig {
    enabled: boolean;
    delaySec: number;
    // Per-channel overrides, `channelId:seconds` (scope.ts owns the format). A
    // channel (or thread) named here ignores `delaySec`; a thread without its own
    // entry inherits its parent channel's. Deliberately a separate field rather
    // than a rewrite of delaySec: the global number stays the global number.
    channelDelays: string;
    // Two lists per layer — shape and composition live in scope.ts.
    serverWhitelist: string; // CSV of guild IDs that flush even so; "@me" means DMs; empty = no restriction
    serverBlacklist: string; // CSV of guild IDs that never flush
    channelWhitelist: string; // CSV of channel/thread IDs that flush REGARDLESS of the server layer (opt-in)
    channelBlacklist: string; // CSV of channel/thread IDs that never flush
    resume: boolean; // honor delete promises that were still owed when the plugin last stopped
}

interface Scheduled {
    timer: ReturnType<typeof setTimeout>;
    tries: number;
    deleteAt: number; // wall-clock ms when the message is due; persisted so a restart can pick the plan back up
}

let getConfig: () => FlushConfig = () => ({ enabled: false, delaySec: 60, channelDelays: "", serverWhitelist: "", serverBlacklist: "", channelWhitelist: "", channelBlacklist: "", resume: true });
let subscribed = false;
const scheduled = new Map<string, Scheduled>();
// When the plugin was (re)started, minus a clock-slack window. MESSAGE_CREATE
// also fires for messages the client replays during channel sync/reconnect —
// scheduling those would burst-DELETE the whole visible history (whose already
// deleted rows surface as 404 spam) and contradict the documented "nothing
// sent before we started is flushed" limit. Only fresh sends get flushed.
const START_SLACK_MS = 5000;
let startedAt = 0;
// Keys we've already sent a DELETE for. A duplicate/replayed MESSAGE_CREATE
// arriving after the delete (our scheduled entry is gone by then) must NOT
// re-fire — one delete promise is honored exactly once.
const recentlyDeleted = new Set<string>();
const DELETED_TTL_MS = 600000;

/** Injected by the plugin entry so this module reads the live settings store without importing it (avoids an import cycle). */
export function configureAutoFlush(fn: () => FlushConfig) {
    getConfig = fn;
}

function currentUserId(): string | null {
    try {
        return UserStore.getCurrentUser()?.id ?? null;
    } catch {
        return null;
    }
}

/** Where a message/channel lives for scope purposes: guild ID, or "@me" for DMs (undiscord's own convention). */
function scopeTarget(message: any, channelId: string): string {
    if (message?.guild_id) return message.guild_id;
    try {
        return ChannelStore.getChannel(channelId)?.guild_id ?? "@me";
    } catch {
        return "@me";
    }
}

/** The two-layer verdict — see scope.ts for the composition (channel opt-in overrides the server layer). */
function inScope(cfg: FlushConfig, target: string, channelId: string): boolean {
    return channelInFlushScope(
        cfg.serverWhitelist, cfg.serverBlacklist, [target],
        cfg.channelWhitelist, cfg.channelBlacklist, channelCandidates(channelId)
    );
}

// ---- scheduling -------------------------------------------------------------

/**
 * The delete promises still owed, mirrored into localStorage so a restart (an
 * update, a crash, switching the plugin off) does not silently cancel them.
 * Keyed "channelId:messageId" → due time.
 */
function persistPlan() {
    const plan: Record<string, number> = {};
    for (const [key, entry] of scheduled) plan[key] = entry.deleteAt;
    writeLocalStorage(PENDING_KEY, JSON.stringify(plan));
}

function readPlan(): Record<string, number> {
    try {
        const raw = readLocalStorage(PENDING_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {}; // corrupt or unreadable — start clean instead of throwing on load
    }
}

/**
 * Picks the owed deletes back up after a start. The scope is re-checked against
 * the *current* settings (the newest intent wins — a channel you have since
 * moved out of auto-flush stays), and anything older than the window is dropped.
 */
function resumePending() {
    const cfg = getConfig();
    if (!cfg.enabled || !cfg.resume) return;

    const plan = readPlan();
    const now = Date.now();
    let resumed = 0;

    for (const [key, deleteAt] of Object.entries(plan)) {
        const [channelId, messageId] = key.split(":");
        if (!channelId || !messageId) continue;
        if (!Number.isFinite(deleteAt) || now - deleteAt > RESUME_MAX_AGE_MS) continue;

        // If the channel resolves, honor the *current* scope; if the store is not
        // ready yet we cannot tell, and the promise made at send time stands.
        let channel: any = null;
        try { channel = ChannelStore.getChannel?.(channelId); } catch { /* store not ready */ }
        if (channel && !inScope(cfg, scopeTarget(null, channelId), channelId)) continue;

        schedule(channelId, messageId, Math.max(deleteAt - now, 0));
        resumed++;
    }

    persistPlan(); // drop whatever was skipped or expired
    if (resumed) console.warn(`[undiscordLite] auto-flush: ${resumed} delete promise(s) left over from the last session — resuming.`);
}

/** One line describing what auto-flush will do as things stand, for the panel to print when it opens. */
export function flushStatusLine(): string {
    const cfg = getConfig();
    if (!cfg.enabled) return "自动冲水：关（你发的消息不会被自动删除）";

    // Both layers always reported, in the user's terms — "which messages survive"
    // is the question this line exists to answer, and silence about a layer reads
    // as "it does nothing". Wording avoids the word 只冲 on purpose: it confused
    // the person this is written for.
    const layer = (white: string, black: string, noun: string, emptyNote = "") => {
        const w = parseIdList(white).length;
        const b = parseIdList(black).length;
        if (w && b) return `${w} 个${noun}自动冲水，其余保留（另排除 ${b} 个）`;
        if (w) return `${w} 个${noun}自动冲水，其余保留`;
        if (b) return `除 ${b} 个${noun}外全部`;
        return `全部${noun}${emptyNote}`;
    };

    // The channel layer reads differently from the server layer now: its allow
    // list is an opt-in ("these too"), not a filter ("only these"), so the verbs
    // differ or the line would describe behaviour that no longer exists.
    const chW = parseIdList(cfg.channelWhitelist).length;
    const chB = parseIdList(cfg.channelBlacklist).length;
    const chBits: string[] = [];
    if (chW) chBits.push(`额外加入 ${chW} 个`);
    if (chB) chBits.push(`排除 ${chB} 个`);
    const channel = chBits.length ? chBits.join("、") : "无额外指定（跟随服务器层）";

    const resumeBit = cfg.resume ? "" : " · 重启后不补删";
    const server = layer(cfg.serverWhitelist, cfg.serverBlacklist, "服务器", "（含私信）");
    const overrides = Object.keys(parseDelayMap(cfg.channelDelays)).length;
    const delayBit = `${clampDelaySec(cfg.delaySec)}s${overrides ? `（另 ${overrides} 个频道/子区自定义）` : ""}`;
    return `自动冲水：开 · 延时 ${delayBit} · 服务器层：${server} · 频道层：${channel} · 待删 ${scheduled.size} 条${resumeBit}`;
}

function schedule(channelId: string, messageId: string, delayMs: number) {
    const key = `${channelId}:${messageId}`;
    if (scheduled.has(key)) return;
    scheduled.set(key, {
        timer: setTimeout(() => flush(key, channelId, messageId), delayMs),
        tries: 0,
        deleteAt: Date.now() + delayMs
    });
    persistPlan();
}

function unschedule(key: string) {
    const entry = scheduled.get(key);
    if (entry) {
        clearTimeout(entry.timer);
        scheduled.delete(key);
    }
}

async function flush(key: string, channelId: string, messageId: string) {
    const entry = scheduled.get(key);
    if (!entry) return; // cancelled (stop / switch off)

    if (!getConfig().enabled || recentlyDeleted.has(key)) {
        unschedule(key);
        persistPlan(); // the promise is void — either flushing is off or it was already kept
        return;
    }

    // Not acked yet (or send failed outright) — wait a bit; give up if it never resolves.
    const msg = (MessageStore as any).getMessage?.(channelId, messageId);
    if (msg?.state === "SENDING" || msg?.state === "FAILED") {
        if (entry.tries >= MAX_TRIES) {
            console.warn(`[undiscordLite] auto-flush gave up on ${channelId}:${messageId} (stuck sending) — leaving it alone`);
            unschedule(key);
            persistPlan();
            return;
        }
        entry.tries++;
        entry.timer = setTimeout(() => flush(key, channelId, messageId), RETRY_MS);
        return;
    }

    let token: string;
    try {
        token = getToken();
    } catch {
        console.warn("[undiscordLite] auto-flush: no auth token available, leaving the message alone");
        return; // keep the entry: the next start retries it rather than losing the promise
    }
    if (!token) return;

    // Claim the key before the request: a replayed MESSAGE_CREATE arriving
    // mid-flight must not queue a second doomed DELETE either.
    recentlyDeleted.add(key);
    const ttl = setTimeout(() => recentlyDeleted.delete(key), DELETED_TTL_MS);

    const retryLater = (why: string) => {
        if (entry.tries >= MAX_TRIES) {
            console.warn(`[undiscordLite] auto-flush gave up on ${channelId}:${messageId} (${why})`);
            unschedule(key);
            persistPlan();
            return;
        }
        entry.tries++;
        clearTimeout(ttl);
        recentlyDeleted.delete(key); // the delete did not land, so the key is free to try again
        entry.timer = setTimeout(() => flush(key, channelId, messageId), RETRY_AFTER_MS);
    };

    try {
        const res = await fetch(`${API_BASE}/channels/${channelId}/messages/${messageId}`, {
            method: "DELETE",
            headers: authHeaders(token)
        });
        // 404/403 = someone (or a race) removed it / can't remove it later either —
        // terminal in both directions, so the promise is settled either way.
        if (res.ok || res.status === 404 || res.status === 403) {
            unschedule(key);
            persistPlan();
            return;
        }
        console.warn(`[undiscordLite] auto-flush failed (${res.status}) for ${channelId}:${messageId} — retrying`);
        retryLater(`${res.status}`);
    } catch {
        console.warn(`[undiscordLite] auto-flush request errored for ${channelId}:${messageId} — retrying`);
        retryLater("network");
    }
}

function onCreate(e: any) {
    if (!subscribed) return;
    const cfg = getConfig();
    if (!cfg.enabled) return;

    const m = e?.message;
    if (!m?.id || !m?.channel_id) return;
    // The optimistic dispatch is the client's local echo at send-press time:
    // its message ID is a placeholder the server never issues. The real ID
    // comes back with the gateway MESSAGE_CREATE that follows, so scheduling
    // the echo guarantees one doomed 404 DELETE per flushed message.
    if (e.optimistic) return;
    if (m.author?.id !== currentUserId()) return;
    if (!inScope(cfg, scopeTarget(m, m.channel_id), m.channel_id)) return;

    // Delete `delay` after the message was SENT. The message timestamp (not the
    // moment this event arrived) is the anchor, so a message from a phone that
    // syncs late still lands where it would have; the arrival time is the
    // fallback only when the event carries no timestamp.
    //
    // Which delay: this channel's override, else its parent channel's, else the
    // global number. Resolved per message rather than per session, so flipping a
    // channel's override takes effect on the very next message without touching
    // the timers already armed (those keep the promise they were made under).
    const { seconds } = resolveDelaySec(cfg.channelDelays, channelCandidates(m.channel_id), cfg.delaySec);
    const delayMs = seconds * 1000;
    const baseMs = m.timestamp ? Date.parse(m.timestamp) : NaN;
    const sentAt = Number.isFinite(baseMs) ? baseMs : Date.now();

    // Only messages that came into the world while we were running. Without
    // this, every channel-sync replay of older own messages would schedule a
    // delete at max(expired, 0) — an immediate DELETE burst against history
    // (404 spam for rows already gone, and live deletions we never promised).
    const key = `${m.channel_id}:${m.id}`;
    if (sentAt < startedAt - START_SLACK_MS) return;
    if (scheduled.has(key) || recentlyDeleted.has(key)) return;

    schedule(m.channel_id, m.id, Math.max(sentAt + delayMs - Date.now(), 0));
}

export function startAutoFlush() {
    if (subscribed) return;
    subscribed = true;
    startedAt = Date.now();
    FluxDispatcher.subscribe("MESSAGE_CREATE", onCreate);
    // Left-over promises from the previous session (see resumePending) come back
    // before the first new message can land, so the queue is accurate from the start.
    resumePending();
}

export function stopAutoFlush() {
    if (!subscribed) return;
    subscribed = false;
    FluxDispatcher.unsubscribe("MESSAGE_CREATE", onCreate);
    // Timers die with the plugin, but the plan itself is already in localStorage:
    // that is exactly what the next start resumes.
    for (const key of [...scheduled.keys()]) unschedule(key);
}
