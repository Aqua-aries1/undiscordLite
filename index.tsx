/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { OptionType } from "@utils/types";
import type { ReactNode } from "react";

import { log, probeAuth } from "./engine/helpers";
import { configureAutoFlush, startAutoFlush, stopAutoFlush } from "./flush/autoFlush";
import { setupScopeContextMenu, teardownScopeContextMenu } from "./flush/contextMenu";
import { migrateLegacyServerLists } from "./flush/scope";
import { OpenUndiscordButton } from "./panel/HeaderButton";
import initUI, { togglePanel } from "./panel/ui";
import { startChineseLayer } from "./panel/zhLayer";
import { parseCustomIcon } from "./repeat/iconChoice";
import { setupQuickRepeat, teardownQuickRepeat } from "./repeat/quickRepeat";
import { UpdateRow } from "./update/UpdateRow";

let disposeUI: (() => void) | null = null;

// Exported so the context-menu module can read and write the live store (the
// settings page repaints from it); it only touches the store inside click
// handlers, so the cycle back into this module is never walked during init.
/**
 * 一次性迁移：旧版把服务器作用域做成「一个适用模式 + 一份名单」，同一份名单按模式被读成
 * 正反两种意思 —— 换模式时名单里的值一动不动、含义却整个翻转（用户反馈"切换的话名单内的值
 * 也不会变啊"）。现在服务器层只有一项可见的「自动冲水的服务器」。
 *
 * 换算规则在 scope.ts 的 migrateLegacyServerLists（纯函数，逐条对齐过旧语义；其中
 * 「只冲名单内 + 空名单」= 谁都不冲这种写法无法直接表达，用不存在的 ID 顶替）。这里只负责
 * 落库：换算完清空旧键，所以只可能发生一次 —— 用户之后手动作废这些表也不会被"还原"。
 *
 * ⚠️ 旧「排除」语义（旧模式「名单外的服务器都冲水」）换算到 `autoFlushServerBlacklist`，
 * 而那一项**界面已隐藏**：可见性可以收掉，判定不能 —— 否则升级后那些服务器的消息会突然
 * 开始被删。非空时状态行会写出来，右键菜单也能改回去。
 */
function migrateLegacyServerScope() {
    const legacyIds = (settings.store.autoFlushScopeIds ?? "").trim();
    if (!legacyIds) return;
    // 已经有新配置就别覆盖（用户先手动配过新表的情况）。
    if (settings.store.autoFlushServerWhitelist || settings.store.autoFlushServerBlacklist) return;

    const { whitelist, blacklist, note } = migrateLegacyServerLists(settings.store.autoFlushScope, legacyIds);
    settings.store.autoFlushServerWhitelist = whitelist;
    settings.store.autoFlushServerBlacklist = blacklist;
    settings.store.autoFlushScopeIds = "";
    if (note) log.info(note);
}

export const settings = definePluginSettings({
    autoFlush: {
        type: OptionType.BOOLEAN,
        displayName: "自动冲水",
        description: "自己发的消息到点自动删除（含其他设备同步来的；开启前已发的不算）",
        default: false,
        restartNeeded: false
    },
    autoFlushDelay: {
        type: OptionType.NUMBER,
        displayName: "冲水延时（秒）",
        description: "发出后多久删除，1–86400。单个频道/子区可以在下一项或右键菜单里另设",
        default: 60,
        restartNeeded: false
    },
    autoFlushChannelDelays: {
        type: OptionType.STRING,
        displayName: "频道冲水时长（单独指定）",
        description: "给单个频道/子区设别的延时，不动上面的全局值；没列出的照旧用全局。格式「频道ID:秒」，多个用逗号或空格分隔。右键频道 →「自动冲水」→「本频道冲水时长」能设常用值。子区没单独设时跟随父频道",
        placeholder: "例如 123456789012345678:30, 234567890123456789:600",
        default: "",
        restartNeeded: false
    },
    autoFlushServerWhitelist: {
        type: OptionType.STRING,
        displayName: "自动冲水的服务器",
        description: "ID 用逗号或空格分隔均可。留空 = 所有服务器都冲；填了则只有列出的会冲，其余（含私信）保留。私信写 @me。单独的频道仍可用下一组「自动冲水的频道」放行",
        placeholder: "例如 123456789012345678 234567890123456789",
        default: "",
        restartNeeded: false
    },
    autoFlushServerBlacklist: {
        type: OptionType.STRING,
        displayName: "不自动冲水的服务器",
        description: "ID 用逗号或空格分隔均可。列出的服务器永不自动冲水，优先于上一项。私信写 @me。（单独的频道仍可用下一组放行）",
        placeholder: "例如 123456789012345678, 234567890123456789",
        default: "",
        restartNeeded: false
    },
    autoFlushChannelWhitelist: {
        type: OptionType.STRING,
        displayName: "自动冲水的频道",
        description: "ID 用逗号或空格分隔均可。列出的频道一律自动冲水——即使它所在的服务器被上一组排除也照冲（右键频道可一键加入）；留空 = 不额外指定，全部跟随服务器层。填父频道 = 连子区",
        placeholder: "例如 123456789012345678 234567890123456789",
        default: "",
        restartNeeded: false
    },
    autoFlushChannelBlacklist: {
        type: OptionType.STRING,
        displayName: "不自动冲水的频道",
        description: "ID 用逗号或空格分隔均可。列出的频道永不自动冲水，优先于上一项、也优先于服务器层；填父频道 = 连子区",
        placeholder: "例如 123456789012345678, 234567890123456789",
        default: "",
        restartNeeded: false
    },
    // 旧的「作用域 + 一份名单」两件套，只剩迁移用途：同一个列表被另一项解释成正反两种意思，
    // 用户明确反馈过看不懂。首次启动会把它换算成上面两张表并清空这里，之后这两项不再有人读，
    // 留着是为了让迁移读数有类型、且老 settings.json 的值不被静默丢弃。
    autoFlushScope: {
        type: OptionType.SELECT,
        hidden: true,
        description: "（旧设置，仅用于一次性迁移）",
        options: [
            { label: "全部（含私信）", value: "all", default: true },
            { label: "只冲水名单内的服务器", value: "whitelist" },
            { label: "名单外的服务器都冲水", value: "blacklist" },
        ],
        restartNeeded: false
    },
    autoFlushScopeIds: {
        type: OptionType.STRING,
        hidden: true,
        description: "（旧设置，仅用于一次性迁移）",
        default: "",
        restartNeeded: false
    },
    autoFlushResume: {
        type: OptionType.BOOLEAN,
        displayName: "重启后补删欠着的冲水",
        description: "还没到点的消息在下次启动后接着删（只补 24 小时内的，按当前名单复核）；关掉则作废",
        default: true,
        restartNeeded: false
    },
    quickRepeat: {
        type: OptionType.BOOLEAN,
        displayName: "一键复读按钮",
        description: "消息工具条里的「复读」按钮：点一下把这条原样再发一条，@ 到的人照常收到通知；纯附件、空消息、超长时没有按钮",
        default: true,
        restartNeeded: false
    },
    quickRepeatMode: {
        type: OptionType.SELECT,
        displayName: "复读模式",
        description: "「直接发出」＝点一下就把这条复读出去（默认）。「预填充」＝只把内容填进输入框，你自己按回车发，还能接着改、也能带上你已经打了一半的话（只对当前打开的频道有效）。消息右键菜单的「自动冲水」里也有这两项，可以直接切",
        options: [
            { label: "直接发出", value: "send", default: true },
            { label: "预填充", value: "compose" },
        ],
        restartNeeded: false
    },
    quickRepeatIcon: {
        type: OptionType.SELECT,
        displayName: "复读按钮的图标",
        description: "下面那项填了自定义图标时，这里选的不生效",
        options: [
            { label: "⟳ 循环箭头（默认）", value: "loop", default: true },
            { label: "⧉ 复制", value: "copy" },
            { label: "◟ 回声波纹", value: "echo" },
            { label: "「复」字", value: "char" },
            { label: "❝ 引号（易被当成引用回复）", value: "quote" },
            { label: "🦜 鹦鹉", value: "parrot" },
        ],
        restartNeeded: false
    },
    quickRepeatCustomIcon: {
        type: OptionType.STRING,
        displayName: "复读图标：自定义",
        description: "填了就覆盖上面的选择：一个 emoji、一两个字，或自建表情 <:名字:id>（动图 <a:名字:id>）",
        placeholder: "例如 🗣 或 <:kusa:123456789012345678>",
        default: "",
        restartNeeded: false
    },
    // Version row. Deliberately the weakest possible update story: it compares
    // the version baked into this build with the published version.json and
    // stops there — no download, no code swap. A userplugin is compiled into the
    // bundle, so "auto update" would mean rewriting dist/ behind the client's
    // back; see update/updateCheck.ts.
    version: {
        type: OptionType.COMPONENT,
        component: UpdateRow
    },
}, {
    quickRepeatCustomIcon: {
        isValid(value) {
            const s = String(value ?? "").trim();
            if (!s) return true; // 留空 = 用预设图标
            return parseCustomIcon(s) != null
                || "只能填一个 emoji、一两个字，或自定义表情 <:名字:id> 形式";
        }
    }
});

export default definePlugin({
    name: "UndiscordLite",
    description: "批量删除 Discord 消息（Undiscord Lite 中文优化版移植：搜索筛选、批次队列、数据导出导入、限速与确认；面板热键 Ctrl+Shift+D）",
    enabledByDefault: true,
    // The repeat button goes through Vencord's message-popover API rather than patching
    // Discord's toolbar markup, so that API plugin has to be on.
    dependencies: ["MessagePopoverAPI"],
    settings,
    authors: [
        { name: "OrbitalCheese", id: 0n },
        { name: "Vencord 移植层", id: 0n },
    ],

    start() {
        migrateLegacyServerScope();
        disposeUI = initUI();
        startChineseLayer();
        setupScopeContextMenu();
        setupQuickRepeat();
        configureAutoFlush(() => ({
            enabled: settings.store.autoFlush,
            delaySec: settings.store.autoFlushDelay,
            channelDelays: settings.store.autoFlushChannelDelays,
            serverWhitelist: settings.store.autoFlushServerWhitelist,
            serverBlacklist: settings.store.autoFlushServerBlacklist,
            channelWhitelist: settings.store.autoFlushChannelWhitelist,
            channelBlacklist: settings.store.autoFlushChannelBlacklist,
            resume: settings.store.autoFlushResume
        }));
        startAutoFlush();

        // One authenticated GET at startup: the first thing to read when search or
        // flushing suddenly stops working, because it separates a bad token from a
        // request shape Discord has started rejecting. Silent while it is healthy.
        probeAuth().then(result => {
            if (!result.includes("→ 200")) log.warn("鉴权自检未通过——" + result);
        });
    },

    stop() {
        teardownScopeContextMenu();
        teardownQuickRepeat();
        stopAutoFlush();
        disposeUI?.();
        disposeUI = null;
    },

    // Chat-header toolbar icon (same mount point Message Logger Enhanced uses):
    // prepend our trash button to the header's toolbar array.
    patches: [
        {
            find: /toolbar:\i,mobileToolbar:\i/,
            replacement: {
                match: /(function \i\(\i\){)(.{1,200}toolbar.{1,100}mobileToolbar)/,
                replace: "$1$self.addIconToToolBar(arguments[0]);$2"
            }
        },
    ],

    addIconToToolBar(e: { toolbar: ReactNode[] | ReactNode; }) {
        if (Array.isArray(e.toolbar))
            return e.toolbar.unshift(
                <ErrorBoundary noop={true}>
                    <OpenUndiscordButton />
                </ErrorBoundary>
            );

        e.toolbar = [
            <ErrorBoundary noop={true} key="udl-button">
                <OpenUndiscordButton />
            </ErrorBoundary>,
            e.toolbar,
        ];
    },

    commands: [
        {
            name: "undiscord",
            description: "打开 / 隐藏 Undiscord 批量删除面板",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: async (_args, ctx) => {
                if (!togglePanel()) {
                    sendBotMessage(ctx.channel.id, {
                        content: "Undiscord 面板当前未挂载（插件刚启用？重新开关一次插件即可）。",
                    });
                }
            },
        },
    ],
});
