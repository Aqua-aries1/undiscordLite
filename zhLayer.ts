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
// 中文界面与轻量 UX 优化
// ----------------------------------------------------------------------------
// 保留原删除核心、确认弹窗、限速和权限预检；这一层只负责界面文本、
// 日志呈现、窄屏布局和快捷键，因此以后更新核心逻辑时更容易合并。
// ============================================================================
function installChineseOptimizations() {
const root = document.querySelector("#undiscord");
if (!root || root.dataset.udlZhInstalled === "1") return Boolean(root);
root.dataset.udlZhInstalled = "1";

const textMap = {
  "Undiscord Lite": "Undiscord Lite（中文优化版）",
  "Bulk delete messages": "批量删除 Discord 消息",
  "General": "常规",
  "Import data export": "导入数据导出",
  "Search filter": "搜索筛选",
  "Delete filter": "删除筛选",
  "Messages interval": "消息范围",
  "Date interval": "日期范围",
  "Delay settings": "延迟设置",
  "Author ID": "作者 ID",
  "Server ID": "服务器 ID",
  "Channel ID": "频道 ID",
  "DMs": "私信",
  "Import folder": "导入文件夹",
  "Exclude all": "全部排除",
  "Exclude Server": "排除服务器",
  "Exclude Channel": "排除频道",
  "Exclude Channel (Keep)": "排除频道（保留）",
  "Exclude DM with User": "排除与指定用户的私信",
  "Include text": "包含文本",
  "Include attachment type": "包含附件类型",
  "Include @user": "包含 @用户",
  "Skip text": "跳过文本",
  "Skip attachment type": "跳过附件类型",
  "Skip extension": "跳过扩展名",
  "Skip @user": "跳过 @用户",
  "Interval of messages": "消息 ID 范围",
  "After date": "起始日期",
  "Before date": "结束日期",
  "Pinned:": "置顶：",
  "Match:": "匹配方式：",
  "exclude": "排除置顶",
  "include": "包含置顶",
  "only pinned": "仅置顶消息",
  "substring": "包含匹配",
  "exact": "完全匹配",
  "Link": "链接",
  "Image": "图片",
  "Video": "视频",
  "Sound": "音频",
  "Sticker": "贴纸",
  "Poll": "投票",
  "Embed": "嵌入内容",
  "Forward": "转发",
  "Exclude NSFW channels": "排除 NSFW 频道",
  "Exclude group DMs": "排除群组私信",
  "Exclude servers": "排除服务器",
  "Exclude DMs": "排除私信",
  "Include @everyone / @here": "包含 @everyone / @here",
  "skip @everyone / @here": "跳过 @everyone / @here",
  "Search delay (ms)": "搜索延迟（毫秒）",
  "Delete delay (ms)": "删除延迟（毫秒）",
  "Streamer mode": "主播模式",
  "Auto scroll": "自动滚动",
  "No import loaded.": "尚未导入数据。",
};

const placeholders = {
  authorId: "作者 ID（留空 = 所有人，可填写多个）",
  guildId: "服务器 ID（可填写多个）",
  channelId: "频道 ID（可填写多个）",
  excludeChannelIds: "要保留的频道 ID（可多个，整服删除时跳过）",
  importExcludeServers: "要跳过的服务器 ID（可多个）",
  importExcludeChannels: "要跳过的频道 ID（可多个）",
  importExcludeUsers: "要跳过的用户 ID（可多个）",
  search: "包含此文本",
  excludeSearch: "跳过包含此文本的消息",
  excludeExtensions: "自定义扩展名：.ext1;.ext2;.ext3",
  mentionsId: "被提及的用户 ID",
  excludeMentionsId: "要跳过的用户 ID（可多个）",
  minId: "晚于此消息 ID",
  maxId: "早于此消息 ID",
};

const buttonText = {
  verify: "📋 校验",
  clear: "🧹 清空日志",
  resetSelection: "↺ 重置选择",
  queueSelection: "批量选择 +",
  dropBatches: "丢弃批次",
  getAuthor: "本人",
  selectAuthor: "选择",
  addGuild: "添加",
  delGuild: "删除",
  selectGuild: "选择",
  addChannel: "添加",
  delChannel: "删除",
  selectChannel: "选择",
  addExcludeChannel: "添加",
  delExcludeChannel: "删除",
  selectExcludeChannel: "选择",
  addAllDms: "添加私信",
  delAllDms: "清空私信",
  importPick: "选择文件夹…",
  importClear: "清除导入",
  addImportExcludeServers: "添加",
  delImportExcludeServers: "删除",
  selectImportExcludeServers: "选择",
  addImportExcludeChannels: "添加",
  delImportExcludeChannels: "删除",
  selectImportExcludeChannels: "选择",
  selectImportExcludeUsers: "选择",
  selectMentions: "选择",
  selectExcludeMentions: "选择",
  selectMinId: "选择",
  selectMaxId: "选择",
  datePresetDay: "近 1 天",
  datePresetWeek: "近 1 周",
  datePresetAll: "全部时间",
  searchDelayDown: "−",
  searchDelayUp: "+",
  searchDelayReset: "↺",
  deleteDelayDown: "−",
  deleteDelayUp: "+",
  deleteDelayReset: "↺",
};

const helpNames = {
  tabGeneral: "常规",
  tabSearchFilter: "搜索筛选",
  tabDeleteFilter: "删除筛选",
  tabMessagesInterval: "消息范围",
  tabDateInterval: "日期范围",
  tabAdvanced: "延迟设置",
  authorId: "作者 ID",
  serverId: "服务器 ID",
  channelId: "频道 ID",
  excludeChannel: "排除频道（保留）",
  dms: "私信",
  includeText: "包含文本",
  includeAttachment: "包含附件类型",
  includeUser: "包含 @用户",
  excludeText: "跳过文本",
  excludeAttachment: "跳过附件类型",
  excludeExtension: "跳过扩展名",
  excludeUser: "跳过 @用户",
  messagesInterval: "消息 ID 范围",
  dateInterval: "日期范围",
  searchDelay: "搜索延迟",
  deleteDelay: "删除延迟",
  importFolder: "导入文件夹",
  importExport: "导入数据导出",
  importExcludeServer: "排除服务器",
  importExcludeChannel: "排除频道",
  importExcludeUser: "排除私信用户",
};

const helpText = {
  tabGeneral: ["设置作者、服务器、频道和私信目标，并构建批量删除队列。", "可以加入多个目标；任务会按顺序执行。", "每个字段旁的“帮助”按钮会显示更具体的使用说明。", "设置会自动记忆——下次打开面板时恢复上次的表单内容（含排除频道、筛选与延迟）；点“重置选择”可清空。"],
  tabSearchFilter: ["限制 Discord 搜索 API 返回的消息范围。", "文本、附件类型和 @用户筛选会在搜索阶段生效，通常比删除后再筛选更快。", "导入数据模式下，本区设置会被忽略。"],
  tabDeleteFilter: ["在搜索结果返回后，从待删除列表中排除消息。", "搜索筛选和删除筛选的同类附件选项互斥，避免出现“必然匹配不到”的组合。", "适合表达“删除所有消息，但保留某类内容”的需求。"],
  tabMessagesInterval: ["用 Discord 消息 ID 限定删除范围。", "可以直接粘贴消息链接，脚本会自动提取末尾的消息 ID。", "消息范围优先于日期范围。"],
  tabDateInterval: ["用日期限定删除范围。", "起始日期不能早于 Discord 的时间起点 2015-01-01；未来日期会自动限制到当前时间。", "如果同时填写消息范围，日期范围会被忽略。"],
  tabAdvanced: ["调整搜索请求间隔和逐条删除间隔。", "遇到 429 限流时脚本会自动增加间隔，并在后续成功请求后逐步恢复。", "降低间隔可能提高速度，但会增加触发限流的概率。"],
  authorId: ["填写要删除其消息的用户 ID；点击“本人”可自动填入自己的 ID。", "留空表示不按作者筛选——范围内所有作者的消息都会被删除（相当于“冲所有人”）。", "开启 Discord 开发者模式后，可以从用户菜单复制用户 ID。", "多个用户 ID 用英文逗号分隔；非本人或留空（所有人）时，需要对目标频道/子区拥有“管理消息”权限，预检会在开始前核对。"],
  serverId: ["填写或添加要处理的服务器。频道 ID 为空时表示处理整个服务器。", "可以点击“选择”，再点击 Discord 左侧的服务器图标来捕获 ID。"],
  channelId: ["将删除范围限制在指定频道。", "可以点击“选择”，再点击 Discord 中的频道或消息来捕获频道 ID。", "留空且已填写服务器 ID 时表示处理整个服务器。"],
  excludeChannel: ["整服删除时保留这些频道——列在这里的频道不会被清理。", "服务器 ID 留空频道 ID 时即整服删除，再把要保留的频道填到这里。搜索结果返回后会在本地丢弃这些频道的消息，任务继续处理其余频道。", "点击“添加”加入当前打开的频道，“删除”移除，“选择”后点击 Discord 中的频道或消息即可捕获；按住 Shift 可连续捕获多个。直接粘贴逗号分隔的 ID 也会追加并去重。", "频道里的“帖子（线程）”在搜索结果中算独立频道，可以单独填它的 ID 只保留该帖子。", "导入数据模式同样生效（与“导入：排除频道”合并）。", "因归档被 Discord 拒绝删除的帖子会自动跳过，无需手动填在这里。"],
  dms: ["“添加私信”会加入当前侧边栏中能从 Discord API 获取的私信频道。", "“清空私信”会移除队列中的所有私信目标；已关闭的私信需要先在 Discord 中重新打开。"],
  includeText: ["只搜索内容包含该文本的消息。", "Discord 搜索通常按词处理，大小写不敏感；留空表示不限制文本。"],
  includeAttachment: ["按链接、图片、视频、音频、贴纸、投票、嵌入或转发类型缩小搜索范围。", "多个选项通常按“同时满足”处理，而不是任意一个满足。"],
  includeUser: ["限制为提及指定用户的消息。", "“包含 @everyone / @here”用于匹配全体或在线成员提及。"],
  excludeText: ["跳过内容包含指定文本的消息。", "“包含匹配”检查子串；“完全匹配”按独立词匹配。"],
  excludeAttachment: ["删除筛选阶段排除指定附件类型的消息。", "导入数据中不存在的元数据选项会自动标记为不可用。"],
  excludeExtension: ["按附件文件扩展名排除消息。", "图片和视频类别的总开关会同步控制常见扩展名。"],
  excludeUser: ["跳过提及指定用户的消息；多个 ID 用英文逗号分隔。", "也可以排除 @everyone / @here。"],
  messagesInterval: ["“晚于此消息 ID”和“早于此消息 ID”都可以直接粘贴消息链接。", "前者必须小于后者，否则任务会被拒绝。"],
  dateInterval: ["日期会在提交时限制到 Discord 的有效时间范围。", "快捷按钮可以快速选择近一天、近一周或全部时间。"],
  searchDelay: ["搜索 API 每页之间的等待时间，单位为毫秒。", "请求被限流时脚本会临时提高该数值。"],
  deleteDelay: ["逐条删除请求之间的等待时间，单位为毫秒。", "请求被限流时脚本会临时提高该数值。"],
  importFolder: ["选择已解压的 Discord 数据导出 messages 文件夹。", "脚本只处理本地导入数据，不会把导出文件上传到其他服务。"],
  importExport: ["导入模式会使用本地数据导出构建删除队列。", "常规队列和搜索筛选会被跳过，日期与消息范围仍然有效。"],
  importExcludeServer: ["从导入数据中排除指定服务器；@me 可用于排除全部私信。"],
  importExcludeChannel: ["从导入数据中排除指定频道。", "可以选择 Discord 中的频道或消息来捕获频道 ID。"],
  importExcludeUser: ["排除包含指定参与者的私信或群组私信。", "服务器消息不按其他作者筛选，因为导出中的服务器消息都来自你自己。"],
};

const titleMap = {
  "Minimize": "最小化",
  "Minimize (run continues in background)": "最小化（任务会在后台继续）",
  "Start the deletion process": "开始删除任务",
  "Print the current run configuration to the log so you can sanity-check it before clicking Delete.": "将当前运行配置打印到日志，点击“删除”前可先检查设置。",
  "Clear the log area": "清空日志",
  "Reset every input field in the sidebar to its default value (does not clear the log or any queued batches).": "将侧栏所有输入恢复为默认值（不会清空日志或已排队批次）。",
  "Snapshot the current selection as a queued batch, then reset the form. Click ▶︎ Delete to run all queued batches sequentially. Pre-flight runs at queue time when non-self authors are present.": "将当前选择保存为已排队批次，然后重置表单。点击“删除”依次运行所有批次；存在非本人作者时，加入队列会先执行权限预检。",
  "An imported export is loaded. The General queue, Search filter, and Delete filter sections are ignored — only Date and Messages interval still apply.": "已加载导入数据。常规队列、搜索筛选和删除筛选会被忽略，只有日期范围和消息范围仍然生效。",
  "Discard every queued batch. Does not affect the current form.": "丢弃所有已排队批次，不影响当前表单。",
  "Number of selection snapshots queued. Click ▶︎ Delete to run them sequentially.": "已排队的选择快照数量。点击“删除”依次运行这些批次。",
  "Clear Author ID": "清空作者 ID",
  "Clear Server (also clears Channel)": "清空服务器（同时清空频道）",
  "Clear Channel only": "仅清空频道",
  "Clear After message ID": "清空晚于此消息 ID",
  "Clear Before message ID": "清空早于此消息 ID",
  "Clear Include text": "清空包含文本",
  "Clear Mentions user IDs": "清空提及用户 ID",
  "Clear Skip text": "清空跳过文本",
  "Clear Skip mentions user IDs": "清空跳过提及的用户 ID",
  "Clear custom extensions": "清空自定义扩展名",
  "Clear excluded servers": "清空已排除的服务器",
  "Clear excluded channels": "清空已排除的频道",
  "Clear excluded users": "清空已排除的用户",
  "Clear the keep-list": "清空保留列表",
  "Add the channel you're currently viewing to the keep-list.": "将当前查看的频道加入保留列表。",
  "Remove the channel you're currently viewing from the keep-list.": "从保留列表移除当前查看的频道。",
  "Queue the server you're currently viewing for a server-wide wipe.": "将当前查看的服务器加入服务器范围删除队列。",
  "Remove the server you're currently viewing from the queue.": "从队列移除当前查看的服务器。",
  "Queue the channel you're currently viewing.": "将当前查看的频道加入队列。",
  "Remove the channel you're currently viewing from the queue.": "从队列移除当前查看的频道。",
  "Queue every DM channel currently open in your sidebar": "将侧栏中当前打开的所有私信频道加入队列。",
  "Remove every queued DM channel from the queue": "从队列移除所有已排队的私信频道。",
  "When checked, age-gated NSFW channels are excluded from Discord's search results. Default: off (NSFW channels are included).": "勾选后，Discord 搜索结果会排除有年龄限制的 NSFW 频道。默认关闭（包含 NSFW 频道）。",
  "When checked, group DMs are excluded from the bulk Add DMs action. Default: off (group DMs are included).": "勾选后，批量“添加私信”操作会排除群组私信。默认关闭（包含群组私信）。",
  "Pick the unzipped 'messages/' folder of your Discord data export": "选择 Discord 数据导出文件中解压后的“messages/”文件夹。",
  "Clear the loaded import and return to live-search mode": "清除已加载的导入数据并返回实时搜索模式。",
  "Drop every guild (server) message during deletion-queue construction. Default: off.": "构建删除队列时排除所有服务器消息。默认关闭。",
  "Drop every 1:1 DM during deletion-queue construction. Default: off.": "构建删除队列时排除所有单聊私信。默认关闭。",
  "Drop every group DM (multi-recipient channel under @me) during deletion-queue construction. Default: off.": "构建删除队列时排除所有群组私信（@me 下的多收件人频道）。默认关闭。",
  "Add the server you're currently viewing to the exclusion list. @me is allowed (skips every DM).": "将当前查看的服务器加入排除列表。允许使用 @me（跳过所有私信）。",
  "Remove the server you're currently viewing from the exclusion list.": "从排除列表移除当前查看的服务器。",
  "Add the channel you're currently viewing to the exclusion list.": "将当前查看的频道加入排除列表。",
  "Remove the channel you're currently viewing from the exclusion list.": "从排除列表移除当前查看的频道。",
  "Click, then click a channel or any message inside one to capture the channel ID. Hold Shift to capture several in a row.": "先点击此按钮，再点击频道或其中任意消息以捕获频道 ID。按住 Shift 可连续捕获多个。",
  "Click, then click a channel or message in Discord to capture its ID": "先点击此按钮，再点击 Discord 中的频道或消息以捕获频道 ID。",
  "Click, then click an avatar/username in Discord to capture the user ID. Hold Shift to capture several in a row.": "先点击此按钮，再点击 Discord 中的头像或用户名以捕获用户 ID。按住 Shift 可连续捕获多个。",
  "Click, then click a server icon in Discord to capture its ID. Hold Shift to capture several in a row.": "先点击此按钮，再点击 Discord 中的服务器图标以捕获服务器 ID。按住 Shift 可连续捕获多个。",
  "Click, then click a server icon in Discord to capture its ID": "先点击此按钮，再点击 Discord 中的服务器图标以捕获服务器 ID。",
  "Click, then click a user or message in Discord to capture their User ID. Hold Shift to capture multiple in a row.": "先点击此按钮，再点击 Discord 中的用户或消息以捕获用户 ID。按住 Shift 可连续捕获多个。",
  "Click, then click a user or message in Discord to capture their User ID": "先点击此按钮，再点击 Discord 中的用户或消息以捕获用户 ID。",
  "Click, then click a message in Discord to capture its ID as the After bound": "先点击此按钮，再点击 Discord 中的消息，将其 ID 作为起始边界。",
  "Click, then click a message in Discord to capture its ID as the Before bound": "先点击此按钮，再点击 Discord 中的消息，将其 ID 作为结束边界。",
  "Messages posted AFTER this date (defaults to Discord's launch — clear or change as needed)": "此日期之后发布的消息（默认从 Discord 上线日期开始，可按需清除或修改）。",
  "Messages posted BEFORE this date": "此日期之前发布的消息。",
  "Now − 24 hours": "现在减 24 小时",
  "Now − 7 days": "现在减 7 天",
  "Reset After to 2015 and clear Before": "将起始日期重置为 2015 年，并清除结束日期。",
  "Click to type a value (auto-clamps to 15000–60000 ms)": "点击输入数值（自动限制在 15000–60000 毫秒）。",
  "Click to type a value (auto-clamps to 100–3000 ms)": "点击输入数值（自动限制在 100–3000 毫秒）。",
  "Reset to default": "恢复默认值",
  "Substring: term appears anywhere in the message. Exact: term must appear as a standalone word.": "包含匹配：词语可以出现在消息任意位置；完全匹配：词语必须作为独立词出现。",
  "Stickers aren't carried in the Discord data export — this toggle has no effect in import mode.": "Discord 数据导出不包含贴纸，此开关在导入模式下无效。",
  "Polls aren't carried in the Discord data export — this toggle has no effect in import mode.": "Discord 数据导出不包含投票，此开关在导入模式下无效。",
  "Embeds aren't carried in the Discord data export — this toggle has no effect in import mode.": "Discord 数据导出不包含嵌入内容，此开关在导入模式下无效。",
  "Forward metadata isn't carried in the Discord data export — this toggle has no effect in import mode.": "Discord 数据导出不包含转发元数据，此开关在导入模式下无效。",
  "Redact message content AND usernames in the log + confirmation preview": "在日志和确认预览中隐藏消息内容及用户名",
};

const dynamicReplacements = [
  [/\bNo import loaded\./g, "尚未导入数据。"],
  [/\bImported (\d[\d,]*) messages? from (\d[\d,]*) channels?\./g, "已导入 $1 条消息，来自 $2 个频道。"],
  [/\bStarting job\.\.\./g, "开始任务…"],
  [/\bJob ended\./g, "任务结束。"],
  [/\bBatch finished\./g, "批量任务完成。"],
  [/\bRunning batch with queue of (\d+) jobs/g, "正在运行批量任务：$1 个任务"],
  [/\bGrand total:/g, "总数："],
  [/\bMessages in current page:/g, "当前页消息："],
  [/\bTo be deleted:/g, "待删除："],
  [/\bSkipped:/g, "已跳过："],
  [/\bOffset:/g, "偏移："],
  [/\bEstimated time remaining:/g, "预计剩余："],
  [/\bNo matching messages found\./g, "没有找到匹配的消息。"],
  [/\bRun completed successfully\./g, "任务已成功完成。"],
  [/\bAll messages deleted:/g, "已删除消息："],
  [/\bRun completed with failures\./g, "任务完成，但存在失败项。"],
  [/\bFailure count:/g, "失败数量："],
  [/\bRun failed early\./g, "任务提前失败。"],
  [/\bFailure mode:/g, "失败原因："],
  [/\bTotal time elapsed:/g, "总耗时："],
  [/\bWaiting for your confirmation\.\.\./g, "等待你的确认…"],
  [/\bAborted by you!/g, "已由你中止！"],
  [/\bStopped by you!/g, "已由你停止！"],
  [/\bOK\b/g, "确认"],
  [/\bSearch request failed/g, "搜索请求失败"],
  [/\bDelete request threw an error/g, "删除请求发生错误"],
  [/\bYour Discord session expired or the token is invalid\./g, "Discord 会话已过期或令牌无效。"],
  [/\bError searching messages, API responded with status (\d+)!/g, "搜索消息出错，API 返回状态 $1！"],
  [/\bError deleting message, API responded with status (\d+)!/g, "删除消息出错，API 返回状态 $1！"],
  [/\bFailed to parse JSON\./g, "解析 JSON 失败。"],
  [/\bRetrying in/g, "将在"],
  [/\bCooling down for/g, "冷却等待"],
  [/\bBeing rate limited by the API for/g, "API 触发限流，持续"],
  [/\bSelection cancelled\./g, "已取消选择。"],
  [/\bSelection mode timed out after 60s — cancelled\./g, "选择模式 60 秒后超时，已取消。"],
  [/\bCaptured/g, "已捕获"],
  [/\bAdded/g, "已添加"],
  [/\bRemoved/g, "已移除"],
  [/\bCleared/g, "已清空"],
  [/\bQueue:/g, "队列："],
  [/\bSearch filter:/g, "搜索筛选："],
  [/\bDelete filter:/g, "删除筛选："],
  [/\bMessages interval:/g, "消息范围："],
  [/\bDate interval:/g, "日期范围："],
  [/\bDelay:/g, "延迟："],
  [/\bMode: import/g, "模式：导入"],
  [/\bMode: live search/g, "模式：实时搜索"],
  [/\bAuthor ID:/g, "作者 ID："],
  [/\bGeneral queue, Search filter, and Delete filter are now bypassed\./g, "常规队列、搜索筛选和删除筛选已跳过。"],
];

function setText(element, value) {
  if (element && element.textContent !== value) element.textContent = value;
}

function translateTextNode(node) {
  const original = node.nodeValue;
  if (!original || !node.parentElement || node.parentElement.closest("script,style,.sm-real,.sm-redacted")) return;
  const trimmed = original.trim();
  let next = textMap[trimmed] ? original.replace(trimmed, textMap[trimmed]) : original;
  for (const [pattern, replacement] of dynamicReplacements) next = next.replace(pattern, replacement);
  if (next !== original) node.nodeValue = next;
}

function translateSubtree(scope) {
  if (!scope || scope.nodeType !== Node.ELEMENT_NODE) return;
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) translateTextNode(node);
}

function translateTree() {
  translateSubtree(root);
}

function translateAttributes() {
  root.querySelectorAll("input[placeholder]").forEach(input => {
    const expected = placeholders[input.id];
    if (expected && input.placeholder !== expected) input.placeholder = expected;
  });
  root.querySelectorAll("[title]").forEach(element => {
    let title = element.getAttribute("title");
    if (!title) return;
    if (titleMap[title]) title = titleMap[title];
    for (const [pattern, replacement] of dynamicReplacements) title = title.replace(pattern, replacement);
    title = title
      .replace(/Show help for /g, "查看帮助：")
      .replace(/Clear /g, "清空")
      .replace(/Start the deletion process/g, "开始删除任务")
      .replace(/Stop the deletion process/g, "停止删除任务")
      .replace(/Select Folder\.\.\./g, "选择文件夹…")
      .replace(/Click, then click /g, "先点击此按钮，再点击")
      .replace(/Hold Shift to capture several in a row\./g, "按住 Shift 可连续捕获多个。")
      .replace(/Hold Shift to capture multiple in a row\./g, "按住 Shift 可连续捕获多个。")
      .replace(/User ID/g, "用户 ID")
      .replace(/Server ID/g, "服务器 ID")
      .replace(/Channel ID/g, "频道 ID")
      .replace(/messages?/g, "消息")
      .replace(/message/g, "消息")
      .replace(/Queue/g, "加入队列")
      .replace(/Remove/g, "移除")
      .replace(/Default/g, "默认")
      .replace(/Now/g, "现在")
      .replace(/Reset/g, "重置");
    if (element.getAttribute("title") !== title) element.setAttribute("title", title);
  });
}

function refreshButtons() {
  const start = root.querySelector("#start");
  const running = Boolean(start && /停止|Stop/.test(start.textContent));
  setText(start, running ? "🛑 停止" : "▶ 删除");
  setText(root.querySelector("#verify"), buttonText.verify);
  setText(root.querySelector("#clear"), buttonText.clear);
  root.querySelectorAll("button.clear-btn").forEach(button => setText(button, "清空"));
  root.querySelectorAll("button.help-btn").forEach(button => {
    setText(button, "帮助");
    const name = helpNames[button.dataset.help];
    const helpTitle = name ? `查看“${name}”帮助` : "";
    if (helpTitle && button.title !== helpTitle) button.title = helpTitle;
  });
  for (const [id, value] of Object.entries(buttonText)) setText(root.querySelector(`#${id}`), value);

  const importBadge = root.querySelector("#importBadge");
  if (importBadge) setText(importBadge, "导入模式");
  const queueBadge = root.querySelector("#queueBadge");
  if (queueBadge) {
    const queueText = queueBadge.textContent.replace(/^\s*queued\s*:/i, "已排队：");
    if (queueBadge.textContent !== queueText) queueBadge.textContent = queueText;
  }
  const drop = root.querySelector("#dropBatches");
  if (drop && /drop batches/i.test(drop.textContent)) setText(drop, "丢弃批次");
  const hide = root.querySelector("#hide");
  if (hide) {
    if (hide.getAttribute("aria-label") !== "最小化") hide.setAttribute("aria-label", "最小化");
    if (hide.title !== "最小化（任务会在后台继续）") hide.title = "最小化（任务会在后台继续）";
  }
}

function appendHelp(key) {
  const entry = helpText[key];
  const logArea = root.querySelector("#logArea");
  if (!entry || !logArea) return false;
  const heading = document.createElement("div");
  heading.className = "log log-info";
  heading.textContent = `── ${helpNames[key] || key} ──`;
  logArea.appendChild(heading);
  for (const line of entry) {
    const item = document.createElement("div");
    item.className = "log log-info";
    item.textContent = `› ${line}`;
    logArea.appendChild(item);
  }
  while (logArea.childElementCount > 1000) logArea.firstElementChild.remove();
  const autoScroll = root.querySelector("#autoScroll");
  if (autoScroll?.checked) logArea.lastElementChild?.scrollIntoView(false);
  return true;
}

// Plugin re-enable installs onto a fresh root; drop the layer's style left over
// from a previous mount so its id never duplicates.
document.getElementById("udl-zh-style")?.remove();
const style = document.createElement("style");
style.id = "udl-zh-style";
style.textContent = `
  /* NO !important on #undiscord's own box rules: the drag layer writes inline
     width/height/top/left when resizing or moving, and an !important here silently
     vetoes every resize handle (the "拖不动/不自适应" bug). Plain rules still win
     the initial layout by cascade order (this sheet loads after the panel's), the
     inline styles win once the user drags, and the viewport max-* clamp keeps the
     panel inside the window in both states. */
  #undiscord {
    width: min(960px, calc(100vw - 20px));
    min-width: 0;
    max-width: calc(100vw - 20px);
    height: min(86vh, 920px);
    max-height: calc(100vh - 70px);
    min-height: 0;
  }
  #undiscord .window-body { min-height: 0; }
  #undiscord .sidebar { width: clamp(250px, 30vw, 310px) !important; }
  #undiscord .main { min-width: 0; max-width: none !important; }
  #undiscord .input-actions { flex-wrap: wrap; }
  #undiscord .input-actions button { min-width: 0; width: auto; flex: 1 1 auto; white-space: nowrap; }
  #undiscord button:focus-visible, #undiscord input:focus-visible, #undiscord select:focus-visible {
    outline: 2px solid #5865f2; outline-offset: 2px;
  }
  #undiscord #logArea { overflow-wrap: anywhere; }
  @media (max-width: 760px) {
    #undiscord { top: 48px; right: 8px; width: calc(100vw - 16px); height: calc(100vh - 58px); }
    #undiscord .window-body { flex-direction: column !important; }
    #undiscord .sidebar { width: 100% !important; height: 46%; max-height: 46%; flex-shrink: 0; }
    #undiscord .main { height: 54%; min-height: 0; }
    #undiscord .header span { max-width: 42vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  }
`;
document.head.appendChild(style);

root.addEventListener("click", event => {
  const button = event.target instanceof Element ? event.target.closest("button.help-btn") : null;
  if (!button || !appendHelp(button.dataset.help)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

let refreshQueued = false;
const scheduleRefresh = () => {
  if (refreshQueued) return;
  refreshQueued = true;
  const run = () => {
    refreshQueued = false;
    translateAttributes();
    refreshButtons();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else setTimeout(run, 0);
};
const observer = new MutationObserver(records => {
  for (const record of records) {
    if (record.type === "characterData") translateTextNode(record.target);
    else if (record.type === "attributes") translateAttributes();
    else for (const node of record.addedNodes) {
      if (node.nodeType === Node.TEXT_NODE) translateTextNode(node);
      else if (node.nodeType === Node.ELEMENT_NODE) translateSubtree(node);
    }
  }
  scheduleRefresh();
});
observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["title", "placeholder", "aria-label"] });

const logArea = root.querySelector("#logArea");
if (logArea?.getAttribute("aria-live") !== "polite") logArea?.setAttribute("aria-live", "polite");
document.addEventListener("keydown", event => {
  if (!root.isConnected || root.style.display === "none") return;
  if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key === "Enter") {
    event.preventDefault();
    root.querySelector("#start")?.click();
  }
});

translateTree();
translateAttributes();
refreshButtons();
return true;
}

function waitForUndiscordChineseUi(attempt = 0) {
if (installChineseOptimizations()) return;
if (attempt < 150) setTimeout(() => waitForUndiscordChineseUi(attempt + 1), 100);
}
export function startChineseLayer() {
    waitForUndiscordChineseUi();
}
