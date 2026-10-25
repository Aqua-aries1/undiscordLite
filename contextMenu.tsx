/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Right-click shortcuts for the auto-flush scope, shaped like Message Logger
// Enhanced's menu. The settings page stays the source of truth: every action
// writes the live settings store, and Vencord's settings modal reads through
// useSettings().
//
// ONE pair of verbs per target — 「移出自动冲水（消息保留）」 / 「加入自动冲水」 —
// labelled by what is true right now and flipped by the click. An earlier version
// also offered 「只让此频道自动冲水（全局）」, a badly-named way of saying "make this
// the only channel that flushes"; the menu no longer does that by accident.
//
// The channel row is always available now. It used to be a disabled line
// explaining that the server layer had excluded the server; the channel layer's
// allow list is an opt-in that overrides the server layer, so 「加入自动冲水」on a
// single channel inside an excluded server does what it says.
//
// REACTIVITY — Discord's Menu API validates its children recursively (Fragments
// are flattened, but anything that is not a Menu item/group is rejected with a
// React error that takes the whole client down). So the rows have to be built
// here, in a plain tree of Menu items — a wrapper component is NOT allowed, no
// matter how convenient `settings.use` looks. That means the rows are a snapshot
// of the settings taken when the menu opens: a click writes the store, but the
// menu itself only rebuilds its rows when its focus path changes — which is
// exactly what moving the mouse does. Hence the old "the radio dot only corrects
// itself once I move the mouse".
//
// The fix is to replay that one event ourselves: Discord's menu items carry an
// `onMouseEnter` that sets the focus path, so after an action we dispatch a
// bubbling `mouseover` on the row we just clicked. The menu rebuilds its rows
// from the settings we just wrote, and the dot/label are correct immediately —
// no mouse movement needed. Each `action` also re-reads the live value instead
// of trusting the snapshot, so clicking twice in a row flips twice correctly
// even if the refresh never lands.
//
// The scope rows also pass `dontCloseOnAction`: a plain MenuItem closes the whole
// context menu on click (that is the default — it means "final selection"), which
// is right for a command but wrong for a switch you want to flip and look at. The
// radio rows never close because Discord hands those components no close hook at
// all.
//
// Layout: one MenuGroup per layer — the channel, then the server (or 私信 for a
// DM) — because that is what the two layers are. The separator is only rendered
// BETWEEN them: with a single group it would just be a stray line at the top.
// Copy speaks in flush terms rather than naming the lists: "whitelist/blacklist"
// reads ambiguously for this feature, and the user has said so twice.

import { addContextMenuPatch, NavContextMenuPatchCallback, removeContextMenuPatch } from "@api/ContextMenu";
import { ChannelStore, GuildStore, Menu, showToast, UserStore } from "@webpack/common";

import { channelCandidates, log } from "./helpers";
import { settings } from "./index";
import { channelInFlushScope, flipScope, listInScope, ScopeLayer } from "./scope";

const REPEAT_MODES = [
    { value: "send", label: "直接发出" },
    { value: "compose", label: "预填充" },
] as const;

function channelIdOf(props: any): string | null {
    return props?.channel?.id ?? props?.message?.channel_id ?? null;
}

function guildIdOf(props: any): string | null {
    const direct = props?.guild?.id ?? props?.channel?.guild_id;
    if (direct) return direct;
    const channelId = channelIdOf(props);
    if (!channelId) return null;
    try {
        return ChannelStore.getChannel(channelId)?.guild_id ?? null;
    } catch {
        return null;
    }
}

/** Header for a channel group: "#name", "@someone" for a DM, else the bare ID. */
function describeChannel(id: string): string {
    try {
        const channel = ChannelStore.getChannel(id);
        if (channel?.name) return `#${channel.name}`;
        if (channel?.isDM?.() || channel?.isGroupDM?.()) {
            const names = (channel.recipients ?? [])
                .map((userId: string) => UserStore.getUser(userId)?.username)
                .filter(Boolean);
            return names.length ? `@${names.join("、")}` : "私信频道";
        }
    } catch { /* fall through */ }
    return id;
}

function describeGuild(id: string): string {
    try {
        return GuildStore.getGuild(id)?.name ?? id;
    } catch {
        return id;
    }
}

function toast(message: string) {
    // The menu action must survive a broken toaster: writing the setting is the
    // point, the confirmation line is not (2026-10: an unguarded toast call took
    // the whole client down — see the README's toasts note).
    try {
        showToast({ text: message, variant: "success" });
    } catch (err) {
        log.warn("toast failed (Discord toast API changed again?)", err);
    }
}

/**
 * Ask the open menu to rebuild its rows so the click looks instant. Menu items
 * set the menu's focus path on mouse-enter; replaying that event makes Discord
 * re-render the menu, which re-runs our patch and rebuilds every row from the
 * settings we just wrote. Wrapped because a menu that fails to refresh is a
 * cosmetic problem, never a reason to break the action (or the client).
 *
 * NOTE: Discord defers an item's `action` to a requestAnimationFrame, so by the
 * time we get here `event.currentTarget` is already null — `event.target` (the
 * node actually clicked, still persisted by `event.persist()`) is what carries
 * us back to the row. The event bubbles, so dispatching on an inner node still
 * reaches the row's own mouse-enter handler.
 */
function refreshMenuAfterClick(event: unknown) {
    try {
        if (typeof MouseEvent !== "function") return;
        const e = event as { currentTarget?: EventTarget | null; target?: EventTarget | null; } | undefined;
        const el = (e?.target ?? e?.currentTarget) as HTMLElement | null | undefined;
        el?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    } catch (err) {
        log.warn("could not refresh the context menu after a click", err);
    }
}

interface ToggleOpts {
    key: string;
    id: string;
    /** Every ID the target answers to, target first — the toggle needs the same set the check used. */
    candidates: string[];
    subject: "频道" | "服务器" | "私信";
    label: string; // for the toast
    /** The effect as it stands, read live (never a snapshot). */
    isFlushed: () => boolean;
    getWhite: () => string;
    setWhite: (csv: string) => void;
    getBlack: () => string;
    setBlack: (csv: string) => void;
}

/**
 * The one scope toggle. Clicking flips exactly the effect the row reports.
 * `layer` tells scope.ts which opt-in shape to use — the server allow list is a
 * filter, the channel allow list is an override. The write is pure (flipScope),
 * so the "clicking always changes the outcome" invariant is checked in node
 * rather than argued here.
 */
function flushToggle(opts: ToggleOpts, layer: ScopeLayer) {
    const { key, id, candidates, subject, label, isFlushed, getWhite, setWhite, getBlack, setBlack } = opts;
    const wasFlushed = isFlushed();

    return (
        <Menu.MenuItem
            id={`undiscordlite-${key}-${id}`}
            label={wasFlushed ? "移出自动冲水（消息保留）" : "加入自动冲水"}
            // Keep the menu open after a toggle: this is a switch, not a
            // final selection. Without this prop Discord closes the whole
            // context menu on the click (its own rows pass the same flag).
            dontCloseOnAction
            action={event => {
                // Re-read rather than trust `wasFlushed`: the row is a snapshot
                // from open time, and the user may click twice.
                const flushed = isFlushed();
                const { white, black, clearedRelatives } = flipScope(getWhite(), getBlack(), candidates, flushed, layer);
                setWhite(white);
                setBlack(black);
                if (flushed) {
                    toast(`${subject}「${label}」的消息会保留下来。`);
                } else {
                    // The two lists cannot say "keep the parent, flush this child", so
                    // un-keeping a child whose parent was the blocker un-keeps the parent
                    // too. Say it rather than let the user find out later.
                    const wider = clearedRelatives.length
                        ? `（并取消了「${clearedRelatives.map(describeChannel).join("、")}」的保留，它的其它子区也一起恢复冲水）`
                        : "";
                    toast(`${subject}「${label}」重新参与自动冲水。${wider}`);
                }
                refreshMenuAfterClick(event);
            }}
        />
    );
}

const patch: NavContextMenuPatchCallback = (children, props) => {
    if (!props) return;
    if (children.some(c => c?.props?.id === "undiscordlite-autoflush")) return;

    const channelId = channelIdOf(props);
    const guildId = guildIdOf(props);
    if (!channelId && !guildId) return;

    // DM channels have no guild: the server layer sees them as "@me", and the
    // group is titled 私信 so the row below is not a mystery box.
    const serverTarget = guildId ?? "@me";
    const serverGroupLabel = guildId ? describeGuild(guildId) : "私信（@me）";
    // Undefined until the user touches the setting — Vencord does not materialise
    // defaults — so normalise here, or the radio row would show nothing selected
    // while the code actually behaves as 直接发出.
    const repeatMode = settings.store.quickRepeatMode === "compose" ? "compose" : "send";

    children.push(
        <Menu.MenuSeparator />,
        // NOTE: the body must stay a plain tree of Menu items — see REACTIVITY above.
        <Menu.MenuItem id="undiscordlite-autoflush" label="自动冲水">
            {channelId && (
                <Menu.MenuGroup label={describeChannel(channelId)}>
                    {flushToggle({
                        key: "ch",
                        id: channelId,
                        candidates: channelCandidates(channelId),
                        subject: "频道",
                        label: describeChannel(channelId),
                        // The channel row reports the COMPOSED verdict: its allow
                        // list can override the server layer, so it can disagree
                        // with the server row on purpose.
                        isFlushed: () => channelInFlushScope(
                            settings.store.autoFlushServerWhitelist, settings.store.autoFlushServerBlacklist, [serverTarget],
                            settings.store.autoFlushChannelWhitelist, settings.store.autoFlushChannelBlacklist, channelCandidates(channelId)
                        ),
                        getWhite: () => settings.store.autoFlushChannelWhitelist,
                        setWhite: csv => { settings.store.autoFlushChannelWhitelist = csv; },
                        getBlack: () => settings.store.autoFlushChannelBlacklist,
                        setBlack: csv => { settings.store.autoFlushChannelBlacklist = csv; },
                    }, "channel")}
                </Menu.MenuGroup>
            )}

            {/* Only between groups: a lone group must not start with a stray line. */}
            {channelId && guildId && <Menu.MenuSeparator />}

            <Menu.MenuGroup label={serverGroupLabel}>
                {flushToggle({
                    key: "srv",
                    id: serverTarget,
                    candidates: [serverTarget],
                    subject: guildId ? "服务器" : "私信",
                    label: serverGroupLabel,
                    // The server row reports the server layer's own verdict.
                    isFlushed: () => listInScope(
                        settings.store.autoFlushServerWhitelist, settings.store.autoFlushServerBlacklist, [serverTarget]
                    ),
                    getWhite: () => settings.store.autoFlushServerWhitelist,
                    setWhite: csv => { settings.store.autoFlushServerWhitelist = csv; },
                    getBlack: () => settings.store.autoFlushServerBlacklist,
                    setBlack: csv => { settings.store.autoFlushServerBlacklist = csv; },
                }, "server")}
            </Menu.MenuGroup>

            <Menu.MenuSeparator />

            <Menu.MenuGroup label="复读模式">
                {REPEAT_MODES.map(({ value, label }) => (
                    <Menu.MenuRadioItem
                        key={value}
                        group="undiscordlite-repeat-mode"
                        id={`undiscordlite-repeat-${value}`}
                        label={label}
                        checked={repeatMode === value}
                        action={event => {
                            settings.store.quickRepeatMode = value;
                            toast(value === "compose"
                                ? "复读模式：预填充（点复读只把内容填进输入框，你自己按回车发）"
                                : "复读模式：直接发出（点复读立刻发出去）");
                            refreshMenuAfterClick(event);
                        }}
                    />
                ))}
            </Menu.MenuGroup>
        </Menu.MenuItem>
    );
};

export function setupScopeContextMenu() {
    addContextMenuPatch("channel-context", patch);
    addContextMenuPatch("message", patch);
    addContextMenuPatch("guild-context", patch);
}

export function teardownScopeContextMenu() {
    removeContextMenuPatch("channel-context", patch);
    removeContextMenuPatch("message", patch);
    removeContextMenuPatch("guild-context", patch);
}
