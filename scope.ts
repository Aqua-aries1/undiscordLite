/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Auto-flush scope decisions, deliberately free of any Discord/webpack import so
// the truth table can be exercised on its own — esbuild a single file and the
// logic runs in plain node:

//   pnpm exec esbuild src/userplugins/undiscordLite/scope.ts --format=cjs --outfile=/tmp/scope.cjs

// Everything the flush path needs to know about "is this message ours to delete"
// is decided here; autoFlush.ts only supplies the live settings and the
// channel/parent IDs.
//
// Two layers, and they no longer compose the same way. The channel layer's
// 「自动冲水的频道」is an OPT-IN that overrides the server layer, so a single
// channel can be pulled into auto-flush even inside a server the server layer
// excludes (the ask was literally "允许仅单频道加入自动冲水"). The server layer
// keeps its own two-list, no-mode shape:
//
//   · 服务器层    「不自动冲水」wins; 「自动冲水」non-empty ⇒ only these flush;
//                 both empty ⇒ no restriction.
//   · 频道层      「不自动冲水」is absolute — an ID here never flushes, even if
//                 a server says flush; 「自动冲水的频道」lists channels that
//                 flush REGARDLESS of the server layer; a channel in neither set
//                 falls back to the server layer's verdict.
//
// An earlier design had a mode plus ONE list for servers, so switching the mode
// silently inverted what the same IDs meant — the list box kept showing the same
// values while the servers it named flipped from "delete" to "keep". Two lists
// make the direction part of the setting rather than part of another setting.

/**
 * Splits a list of IDs. Separators are commas and/or whitespace — one per line,
 * "a, b", "a b" and "a，b" all work — because these lists are filled by pasting
 * IDs from Discord, where they arrive in whichever shape the source used.
 *
 * Writes always come back joined with a single comma (`addId` / `removeId` below
 * normalise), so the stored value has exactly one shape to read.
 */
export function parseIdList(csv: string | undefined | null): string[] {
    return String(csv ?? "").split(/[\s,，、]+/).filter(Boolean);
}

/**
 * Does a target pass ONE layer's two lists? This is the per-layer primitive;
 * the two-layer composition lives in `channelInFlushScope` below.
 *
 * `candidates` is every ID the target answers to: a server is itself ("@me" for
 * DMs); a channel is itself plus, for a thread or forum post, its parent
 * channel — so listing either end of that pair covers both, and keeping a forum
 * channel also keeps the posts inside it.
 */
export function listInScope(
    whiteCsv: string | undefined | null,
    blackCsv: string | undefined | null,
    candidates: string[]
): boolean {
    const ids = candidates.filter((id): id is string => !!id);
    const black = parseIdList(blackCsv);
    if (ids.some(id => black.includes(id))) return false;

    const white = parseIdList(whiteCsv);
    if (white.length === 0) return true;
    return ids.some(id => white.includes(id));
}

/**
 * The two-layer flush verdict for one channel.
 *
 * The channel layer's exclude list is absolute: any candidate is in it ⇒ never
 * flush here, whatever the server layer says. Its allow list is an OPT-IN: any
 * candidate is in it ⇒ flush here, overriding the server layer — that is how a
 * single channel inside an excluded server gets pulled back in. A channel in
 * neither channel-layer list is decided by the server layer alone.
 *
 * (The server allow list is a FILTER — non-empty ⇒ only those servers flush.
 * The two allow lists look alike and mean different things; keeping the
 * composition in one pure function is how that asymmetry stays checkable.)
 */
export function channelInFlushScope(
    serverWhiteCsv: string | undefined | null,
    serverBlackCsv: string | undefined | null,
    serverCandidates: string[],
    channelWhiteCsv: string | undefined | null,
    channelBlackCsv: string | undefined | null,
    channelCandidates: string[]
): boolean {
    const chans = channelCandidates.filter((id): id is string => !!id);
    const chBlack = parseIdList(channelBlackCsv);
    if (chans.some(id => chBlack.includes(id))) return false;
    const chWhite = parseIdList(channelWhiteCsv);
    if (chans.some(id => chWhite.includes(id))) return true;
    return listInScope(serverWhiteCsv, serverBlackCsv, serverCandidates);
}

/** Appends an ID when absent; order preserved, no duplicates. */
export function addId(csv: string | undefined | null, id: string): string {
    const list = parseIdList(csv);
    if (!list.includes(id)) list.push(id);
    return list.join(",");
}

/** Drops every occurrence of an ID. */
export function removeId(csv: string | undefined | null, id: string): string {
    return parseIdList(csv).filter(x => x !== id).join(",");
}

// ---- the scope toggle's decision --------------------------------------------

export interface ScopeLists {
    white: string;
    black: string;
    /**
     * Candidates other than the target that had to be touched, because they were
     * what actually held the target in (or out of) scope. Empty in the ordinary
     * case; non-empty means the click reached wider than the label suggested and
     * the caller should say so.
     */
    clearedRelatives: string[];
}

/** Which layer a toggle belongs to — the two opt-IN branches differ (see flipScope). */
export type ScopeLayer = "server" | "channel";

/**
 * What a right-click toggle writes for one layer. `ids` is every ID the target
 * answers to, the target itself first (a channel, then its parent).
 *
 * Opting OUT (flushed → true) is the same for both layers: put the target's own
 * ID in the exclude list. The exclude list is checked against every candidate,
 * so that entry always lands — a "trim only the allow list" variant looks
 * reasonable and fails this file's own invariant (it passed review once).
 *
 * Opting IN (flushed → false) differs by layer:
 *   · server  — the allow list is a FILTER, so clearing the exclude list is
 *     enough unless the allow list is in use, in which case the target must
 *     also be listed (otherwise the click leaves it filtered out).
 *   · channel — the allow list is an OPT-IN, so the target is always written
 *     into it (that write is what overrides the server layer). The allow list is
 *     otherwise left untouched: a parent entry must keep covering its threads.
 *   Either way an exclude entry on a *relative* has to be cleared too — it
 *   blocks by candidate — and that reaches wider than the label, so those IDs
 *   come back in `clearedRelatives` instead of being applied quietly.
 *
 * The invariant the caller relies on: applying this always inverts the layer's
 * verdict for those same `ids` (proved over the full state matrix in node).
 */
export function flipScope(
    white: string | undefined | null,
    black: string | undefined | null,
    ids: string[],
    flushed: boolean,
    layer: ScopeLayer = "server"
): ScopeLists {
    const candidates = ids.filter((id): id is string => !!id);
    const [self] = candidates;
    if (!self) return { white: white ?? "", black: black ?? "", clearedRelatives: [] };

    if (flushed) {
        // Always write the target into the exclude list. Trimmed-down variants
        // are wrong: when the target is in scope because a RELATIVE matches
        // (a thread whose parent is listed), removing only the target from the
        // allow list changes nothing — the parent still matches. The exclude
        // list is checked against every candidate, so an entry here is the one
        // thing that always lands.
        return { white: removeId(white, self), black: addId(black, self), clearedRelatives: [] };
    }

    const kept = parseIdList(black);

    if (layer === "channel") {
        // Opt-in overrides the server layer ⇒ the target must be in the allow
        // list, and any exclude entry on it or a relative has to go so nothing
        // blocks it. The allow list itself stays put (a parent entry keeps
        // covering its threads).
        const clearedRelatives = candidates.slice(1).filter(id => kept.includes(id));
        let b = black ?? "";
        for (const id of candidates) b = removeId(b, id);
        return { white: addId(white, self), black: b, clearedRelatives };
    }

    const held = parseIdList(white);
    const clearedRelatives = candidates
        .slice(1)
        .filter(id => held.includes(id) || kept.includes(id));

    let w = white ?? "";
    let b = black ?? "";
    for (const id of candidates) {
        w = removeId(w, id);
        b = removeId(b, id);
    }
    if (held.length > 0) w = addId(w, self);
    return { white: w, black: b, clearedRelatives };
}

// ---- per-channel flush delay -------------------------------------------------

/**
 * Delay overrides live in ONE string setting: `channelId:seconds` entries,
 * separated by the same characters the ID lists accept. A record would read
 * better, but Vencord settings only speak scalars — and a string keeps the value
 * hand-editable in the settings box. The right-click menu is the fast path; the
 * box is the exact one, and both write the same field.
 */
export const DELAY_MIN_SEC = 1;
export const DELAY_MAX_SEC = 86400;

/**
 * Seconds → a value setTimeout can be trusted with. A cleared or garbage number
 * field lands as NaN, and `setTimeout(NaN)` fires immediately — which would
 * flash-delete everything. Non-finite therefore means "the factory default",
 * not "zero".
 */
export function clampDelaySec(sec: number): number {
    if (!Number.isFinite(sec)) return 60;
    return Math.min(Math.max(Math.round(sec), DELAY_MIN_SEC), DELAY_MAX_SEC);
}

/** `"111:30,222:600"` → `{111: 30, 222: 600}`. Anything unparsable is skipped, never fatal. */
export function parseDelayMap(text: string | undefined | null): Record<string, number> {
    const out: Record<string, number> = {};
    for (const token of String(text ?? "").split(/[\s,，、]+/)) {
        if (!token) continue;
        // Snowflakes are 17–20 digits; the separator is `:` or `=` so a stray
        // pasted `id: id` pair does not silently become a 0-second override.
        const m = /^(\d{17,20})[:=](\d+)$/.exec(token);
        if (!m) continue;
        const sec = Number(m[2]);
        if (Number.isFinite(sec) && sec >= DELAY_MIN_SEC && sec <= DELAY_MAX_SEC) out[m[1]] = Math.round(sec);
    }
    return out;
}

/** The one shape a written map takes: sorted by ID, single commas. */
export function formatDelayMap(map: Record<string, number>): string {
    return Object.keys(map).sort().map(id => `${id}:${map[id]}`).join(",");
}

/** Set (or clear, with `null`) one channel's override. Everything else is preserved. */
export function setChannelDelay(text: string | undefined | null, channelId: string, seconds: number | null): string {
    const map = parseDelayMap(text);
    if (!channelId) return formatDelayMap(map);
    if (seconds === null) delete map[channelId];
    else map[channelId] = clampDelaySec(seconds);
    return formatDelayMap(map);
}

export interface ResolvedDelay {
    seconds: number;
    /** Which level answered — the menu labels the row with this. */
    source: "channel" | "parent" | "global";
    matchedId?: string;
}

/**
 * The delay for one channel: its own override, else its parent's, else global.
 *
 * `candidates` is [channel, parent?] — the same shape the scope checks use, so a
 * thread follows its parent channel and a parent's override covers the whole
 * subtree. A thread with its own entry keeps it (that is how one thread gets a
 * different delay from its siblings).
 */
export function resolveDelaySec(
    text: string | undefined | null,
    candidates: string[],
    globalSec: number
): ResolvedDelay {
    const map = parseDelayMap(text);
    const ids = candidates.filter((id): id is string => !!id);
    const [self, ...relatives] = ids;
    if (self && map[self] != null) return { seconds: map[self], source: "channel", matchedId: self };
    for (const id of relatives) {
        if (map[id] != null) return { seconds: map[id], source: "parent", matchedId: id };
    }
    return { seconds: clampDelaySec(globalSec), source: "global" };
}

/** `45` → `45 秒`; `600` → `10 分钟`; `5400` → `1 小时 30 分`. */
export function describeDelay(sec: number): string {
    const s = clampDelaySec(sec);
    if (s < 60) return `${s} 秒`;
    if (s < 3600) {
        const m = Math.floor(s / 60);
        const rest = s % 60;
        return rest ? `${m} 分 ${rest} 秒` : `${m} 分钟`;
    }
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

// ---- one-time migration from the old "mode + one list" server scope ----------

/**
 * Deliberately unmatchable: a real Discord ID is a 17–19 digit snowflake, so
 * this can never be a server. See the migration below for why it exists.
 */
export const FLUSH_NOTHING = "0";

export interface MigratedScope {
    whitelist: string;
    blacklist: string;
    note: string; // empty when there was nothing to say
}

/**
 * Old server scope (a mode + ONE list, the same list read in whichever direction
 * the mode chose) → the new two-list model, preserving behaviour entry for entry.
 * Pure so the equivalence can be checked in node against the old rule instead of
 * against a copy of it:
 *
 *   whitelist + list → 自动冲水的服务器
 *   blacklist + list → the exclude list (hidden in the UI, still honoured)
 *   all              → both empty (the list was inert in this mode, so it is
 *                      dropped rather than silently promoted to a real rule)
 *
 * The one case that does NOT collapse is `whitelist` with an EMPTY list: the old
 * rule ("listed ones flush") makes that "flush nothing", while an empty
 * whitelist now means "no restriction". Falling through would have turned a
 * keep-everything config into a delete-everything one, so it is spelled out with
 * an unmatchable ID the user can see and clear.
 */
export function migrateLegacyServerLists(mode: string | undefined | null, ids: string | undefined | null): MigratedScope {
    const list = parseIdList(ids).join(",");

    if (!list) {
        return mode === "whitelist"
            ? {
                whitelist: FLUSH_NOTHING,
                blacklist: "",
                note: `旧的服务器作用域是「只冲水名单内的服务器」但名单是空的，等于谁都不冲；已用不存在的 ID「${FLUSH_NOTHING}」写进「自动冲水的服务器」表达同样的意思（清空这一项就变回「所有服务器都冲」）。`,
            }
            : { whitelist: "", blacklist: "", note: "" };
    }

    if (mode === "whitelist")
        return { whitelist: list, blacklist: "", note: `旧的服务器名单已换算为「自动冲水的服务器」：${list}` };

    if (mode === "blacklist")
        return { whitelist: "", blacklist: list, note: `旧的服务器名单是「排除」语义，已写入隐藏的排除项（界面不显示，判定照旧生效）：${list}` };

    return { whitelist: "", blacklist: "", note: `旧的服务器作用域是「全部」，那份名单（${list}）在旧版本来就不生效，已清空。` };
}
