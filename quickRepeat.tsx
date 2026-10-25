/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// 一键复读: a repeat button in the message hover toolbar — the same inline strip
// SilentDelete's trash icon and the quick reactions live in — registered through
// Vencord's official MessagePopover API instead of patching Discord's toolbar
// markup. It shows on everyone's messages, not just your own: the point of 复读
// is echoing what someone else said in one click.
//
// What an echo carries:
//   · the text;
//   · the attachments, re-uploaded (Discord has no "forward these files" send),
//     which is also what makes an attachment-only message repeatable;
//   · the reply reference you already have pending in the composer, so echoing
//     while you are replying to someone stays a reply to that someone. The
//     composer's pending reply is left alone — this does not consume it.
//
// The echo is a normal send, so auto-flush schedules it for deletion like any
// other message of yours (the schedule is driven by MESSAGE_CREATE, not by the
// send path). Only one part needs a hand, because this bypasses the composer:
// when there are files, the send itself — see the comment in repeatMessage.

import { addMessagePopoverButton, removeMessagePopoverButton } from "@api/MessagePopover";
import { ClockIcon } from "@components/Icons";
import { insertTextIntoChatInputBox, sendMessage } from "@utils/discord";
import { ChannelStore, Constants, DraftType, MessageActions, PendingReplyStore, PermissionsBits, PermissionStore, RestAPI, SelectedChannelStore, showToast, SnowflakeUtils, UploadHandler, UserStore } from "@webpack/common";

import { log } from "./helpers";
import { parseCustomIcon } from "./iconChoice";
import { settings } from "./index";

/** Discord's own limit for the message body; nitro accounts get the larger one. */
function sendLimit(): number {
    return UserStore.getCurrentUser()?.premiumType === 2 ? 4000 : 2000;
}

/** Discord's per-upload ceiling, same split as the text limit. */
function uploadLimitBytes(): number {
    return (UserStore.getCurrentUser()?.premiumType === 2 ? 100 : 10) * 1024 * 1024;
}

/** Discord accepts at most 10 attachments on one message. */
const MAX_ATTACHMENTS = 10;

/**
 * Suffix for upload-slot ids. Discord hands each slot back with the id we asked
 * for, and that id is what ties the uploaded bytes to the message that follows,
 * so two slots must never share one — `Date.now()` alone could collide when a
 * message carries several files.
 */
let uploadSeq = 0;

/** Keys with a send in flight — a second click must not post a second echo. */
const sending = new Set<string>();

/**
 * Whether we may post in this channel. Only asked for guild channels: a DM's
 * bits are meaningless here, and a wrong answer must never hide a working button.
 */
function canSend(channel: any): boolean {
    if (!channel?.guild_id) return true;
    try {
        return PermissionStore.can(PermissionsBits.SEND_MESSAGES, channel);
    } catch {
        return true;
    }
}

/**
 * Vencord 的 toast API 换过两次：先是 `Toasts.Type` / `Toasts.genId` /
 * `Toasts.show({type, message, id})` 这套整体没了，之后又改成对象式
 * `showToast({text, variant, icon})`（`variant` 只有 default/success/critical）。
 * 位置参数写法在这版里不抛但也不生效：消息落进 `data`，`data.text` 是 undefined，
 * 弹出空条，表现成"点了没反应、也没有报错"。
 */
function toast(message: string, failure = false, busy = false) {
    // Never let the notification take the action down with it: a toast that no
    // longer matches Discord's API used to throw (and once crashed the client —
    // this toast layer has broken features three times). Losing a line of
    // feedback is survivable; losing the click is not.
    try {
        showToast({ text: message, variant: failure ? "critical" : "success", icon: busy ? ClockIcon : undefined });
    } catch (err) {
        log.warn("toast failed (Discord toast API changed again?)", err);
    }
}

/** Everything an echo would carry: the text and the attachments to re-upload. */
function repeatPlan(message: any): { content: string; attachments: any[]; } | null {
    if (!message || message.deleted) return null;
    const content = message.content ?? "";
    const attachments = (message.attachments ?? []).slice(0, MAX_ATTACHMENTS);
    // Sticker-only, embed-only and slash-echo rows carry nothing we can re-send.
    if (!content.trim() && attachments.length === 0) return null;
    return { content, attachments };
}

/**
 * Copies one attachment into this channel: ask for an upload slot, PUT the bytes
 * there, and hand back what the message body wants. Discord's own uploader does
 * the same two steps; the file is fetched from the CDN URL Discord already gave
 * us, so nothing depends on a local path.
 */
async function reuploadAttachment(channelId: string, attachment: any) {
    const source = await fetch(attachment.url);
    if (!source.ok) throw new Error(`下载附件失败（${source.status}）`);
    const blob = await source.blob();

    const slotId = `${Date.now()}${String(uploadSeq++).padStart(3, "0")}`;
    const { body } = await RestAPI.post({
        url: `/channels/${channelId}/attachments`,
        body: {
            files: [{
                filename: attachment.filename,
                file_size: blob.size,
                id: slotId,
                is_clip: false
            }]
        }
    }) as { body: { attachments: { id: string; upload_url: string; upload_filename: string; }[]; }; };

    const slot = body.attachments[0];
    const put = await fetch(slot.upload_url, { method: "PUT", body: blob });
    if (!put.ok) throw new Error(`上传附件失败（${put.status}）`);

    return { id: slot.id, filename: attachment.filename, uploaded_filename: slot.upload_filename };
}

/**
 * 「写进输入框」模式：只把复读内容摆进编辑器，发不发、什么时候发由你决定
 * （可以接着改字，也能顺手带上你已经打了一半的那句）。
 *
 * Only for the channel that is actually open: a composer belongs to one channel and
 * INSERT_TEXT goes to whatever input is mounted right now, so writing content from
 * another channel's message would land it in the wrong box — a misfire that looks
 * like it worked. Refuse out loud instead of guessing.
 *
 * No success toast on the happy path: the text landing in the box is the feedback,
 * and Discord's own upload preview covers the files. A toast per click was noise.
 */
async function composeEcho(message: any, content: string, attachments: any[]) {
    if (message.channel_id !== SelectedChannelStore.getChannelId()) {
        toast("这条消息不在你当前打开的频道里，写进输入框会写错地方——先切到那个频道再来。", true);
        return;
    }

    // Text first, so it is visible while files upload behind it. The box may already
    // hold a half-written message: INSERT_TEXT appends, it does not replace.
    if (content) insertTextIntoChatInputBox(content);

    if (attachments.length) {
        const channel = ChannelStore.getChannel(message.channel_id);
        // promptToUpload is the very door the composer's own paste/drop uses, so these
        // become ordinary pending attachments — uploaded, previewed, and validated by
        // Discord (its own size/count prompts) instead of a second copy of those rules
        // living here. fakeNitro and petpet hand files over the same way.
        const files: File[] = [];
        for (const attachment of attachments) {
            const res = await fetch(attachment.url);
            if (!res.ok) throw new Error(`下载附件失败（${res.status}）`);
            const blob = await res.blob();
            files.push(new File([blob], attachment.filename, { type: blob.type || attachment.content_type || "application/octet-stream" }));
        }
        UploadHandler.promptToUpload(files, channel, DraftType.ChannelMessage);
    }
}

async function repeatMessage(message: any) {
    const plan = repeatPlan(message);
    if (plan == null) return;

    const key = `${message.channel_id}:${message.id}`;
    if (sending.has(key)) return; // a double-click must not post two echoes
    sending.add(key);

    try {
        const { content, attachments } = plan;

        // 「写进输入框」模式：什么都不发，只把内容摆到编辑器里，发不发的权利交给用户。
        // 放行前不做长度/大小预检 —— 编辑器自己有 Discord 原生的提示，规则不必抄两份
        // （唯一保留的是 10 个附件的截断，那在 repeatPlan 里）。
        if (settings.store.quickRepeatMode === "compose") {
            await composeEcho(message, content, attachments);
            return;
        }

        const limit = sendLimit();
        if (content.length > limit) {
            toast(`这条消息有 ${content.length} 字，超过 ${limit} 字上限，复读不了。`, true);
            return;
        }

        const oversized = attachments.filter(a => a.size > uploadLimitBytes());
        if (oversized.length) {
            const mb = (uploadLimitBytes() / 1024 / 1024).toFixed(0);
            toast(`有 ${oversized.length} 个附件超过 ${mb} MB，Discord 不让传，复读不了。`, true);
            return;
        }

        // The reply target already sitting in the composer is carried over: echoing
        // while replying to someone keeps it a reply to that someone. It is NOT
        // cleared, so whatever you were typing stays a reply too.
        const pendingReply = PendingReplyStore.getPendingReply(message.channel_id);
        const options = pendingReply
            ? MessageActions.getSendMessageOptionsForReply(pendingReply)
            : undefined;

        // Attachments have to travel again — re-uploading is the only way to echo
        // files, and it is the slow part, so say so before the wait.
        if (attachments.length) toast(`正在复读（要重新上传 ${attachments.length} 个附件）…`, false, true);
        const uploaded: { id: string; filename: string; uploaded_filename: string; }[] = [];
        for (const attachment of attachments) uploaded.push(await reuploadAttachment(message.channel_id, attachment));

        // Sent as a plain message: no SUPPRESS_NOTIFICATIONS flag, so whatever the
        // echoed text mentions notifies exactly as it would if you typed it.
        // `any` because the attachment slots are Discord's internal shape, which
        // its own types don't model for outbound sends.
        const data: any = { content };
        if (uploaded.length) data.attachments = uploaded;

        if (uploaded.length) {
            // Files force the raw endpoint. `MessageActions.sendMessage` builds its
            // payload from the composer's upload manager, so a message object that
            // merely *carries* `attachments` gets its text sent and its files
            // dropped, with no error anywhere — which is exactly how this broke the
            // first time. voiceMessages and SilentDelete send the same way for the
            // same reason. Not optimistic, so the echo appears when the gateway
            // sends it back (a moment later than a typed message would).
            const res = await RestAPI.post({
                url: Constants.Endpoints.MESSAGES(message.channel_id),
                body: {
                    content: data.content,
                    tts: false,
                    mobile_network_type: "unknown",
                    flags: 0,
                    nonce: SnowflakeUtils.fromTimestamp(Date.now()),
                    // `id` here is the slot id from the upload, not an array index:
                    // that is the only thing tying these bytes to this message.
                    attachments: uploaded.map(a => ({ id: a.id, filename: a.filename, uploaded_filename: a.uploaded_filename })),
                    message_reference: (options as any)?.messageReference ?? undefined
                }
            });
            if (!res.ok || !res.body?.id) throw new Error(`发送失败（${res.status}）`);
            // The one failure this plugin already shipped once: Discord accepts the
            // message and the files vanish. Read the count back so that can never be
            // silent again — the message is already sent by now, so the toast says so.
            const landed = (res.body as any)?.attachments?.length ?? 0;
            if (landed < uploaded.length)
                throw new Error(`这条发出去了，但附件没跟上（Discord 只收下 ${landed}/${uploaded.length} 个）`);
        } else {
            await sendMessage(message.channel_id, data, true, options as any);
        }
    } catch (err) {
        const text = String(err);
        const hint = /403|forbidden|missing permission/i.test(text) ? "（没有在这个频道发言的权限）" : "";
        log.warn(`复读失败：${err}`);
        toast(`复读失败${hint}：${err}`, true);
    } finally {
        sending.delete(key);
    }
}

/**
 * The button glyph: a user-typed icon if there is one, otherwise the preset
 * chosen in settings. 复读 is a cultural gesture — the parrot is what 复读机
 * means to a Chinese reader — while the loop arrow is what a Discord-native
 * toolbar would use. The emoji/text variants sit fine next to Discord's own
 * coloured quick-reaction buttons, which live in the same strip.
 */
function RepeatIcon() {
    // Runs the same parser the setting's isValid runs, so any value that got
    // past input validation draws here; the fallback below is for a store
    // written around the UI rather than for normal use.
    const custom = parseCustomIcon(settings.store.quickRepeatCustomIcon);
    if (custom) {
        return custom.kind === "emoji"
            ? <img src={custom.url} alt="" width={18} height={18} style={{ display: "block" }} />
            : <span style={{ fontSize: 15, lineHeight: 1 }}>{custom.text}</span>;
    }

    switch (settings.store.quickRepeatIcon) {
        case "copy":
            // Two pages: "take a copy of this and send it".
            return (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1Zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H8V7h11v14Z" />
                </svg>
            );
        case "echo":
            // A dot with sound waves: literally an echo.
            return (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                    <circle cx="7" cy="12" r="1.8" fill="currentColor" stroke="none" />
                    <path d="M11.5 8.5a5 5 0 0 1 0 7" />
                    <path d="M15.5 5.8a9 9 0 0 1 0 12.4" />
                </svg>
            );
        case "char":
            return <span style={{ fontSize: 13, fontWeight: 700, lineHeight: 1 }}>复</span>;
        case "quote":
            return <span style={{ fontSize: 18, lineHeight: 1 }}>❝</span>;
        case "parrot":
            return <span style={{ fontSize: 16, lineHeight: 1 }}>🦜</span>;
        default:
            // Material "repeat": the least likely to be misread, and the closest
            // to how Discord draws its own toolbar glyphs.
            return (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7Zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4Z" />
                </svg>
            );
    }
}

export function setupQuickRepeat() {
    addMessagePopoverButton("UndiscordLiteRepeat", message => {
        if (!settings.store.quickRepeat) return null;
        if (repeatPlan(message) == null) return null;

        const channel = ChannelStore.getChannel(message.channel_id);
        if (!channel) return null;
        if (!canSend(channel)) return null; // a button that could only 403 is worse than no button

        return {
            label: "复读这条消息",
            icon: RepeatIcon,
            message,
            channel,
            onClick: () => void repeatMessage(message)
        };
    }, RepeatIcon);
}

export function teardownQuickRepeat() {
    removeMessagePopoverButton("UndiscordLiteRepeat");
}
