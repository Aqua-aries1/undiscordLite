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
// UNDISCORD CORE — DELETE LOOP
// ----------------------------------------------------------------------------
// Owns the message-search-and-delete pipeline and the in-flight statistics it
// produces. The UI layer feeds in `options`, listens on `onStart` /
// `onProgress` / `onStop` / `onJob`, and calls `run()` (single target) or
// `runBatch(queue)` (multiple). Pulls pages from Discord's search API, or
// from an in-memory ImportSource when one is supplied.
// ============================================================================
import { askYesNo, authHeaders, buildContentMatcher, buildExtensionMatcher,escapeHTML, log, msToHMS, parseCsvList, queryString, redactHtml, toSnowflake } from "./helpers";
const API_BASE = "https://discord.com/api/v9";
const MAX_DELETE_ATTEMPTS = 2; // Per-message retry on transient failures.
const MAX_TRANSIENT_RETRIES = 3; // Search-side retries for 5xx and network errors.


// ============================================================================
// DEFAULT OPTIONS
// ----------------------------------------------------------------------------
// Canonical schema for `core.options`. The constructor and `resetOptions()`
// both seed from this; the UI orchestrators hand in a partial overlay. Add
// new options here so both seed paths pick them up.
// ============================================================================

const DEFAULT_OPTIONS = {
  authToken: null,
  authorId: null,
  guildId: null,
  channelId: null,
  minId: null,
  maxId: null,
  // Server-side search filters — passed through to Discord's search API.
  content: null,
  hasLink: null, // has an auto-embedded link preview
  hasImage: null, // has image attachment
  hasVideo: null, // has video attachment
  hasSound: null, // has audio attachment
  hasSticker: null, // has sticker
  hasPoll: null, // has a poll
  hasEmbed: null, // has any embed (broader than link — includes manual embeds)
  hasForward: null, // has a forwarded message snapshot
  mentions: null, // @mentioning this user ID
  mentionEveryone: null, // has @everyone / @here
  pinnedMode: "exclude", // 'exclude' | 'include' | 'only'
  excludeNsfw: false, // when true, age-gated NSFW channels are excluded; when false, Discord's include_nsfw=true is sent
  // Post-search (client-side) filters — applied in filterResponse against
  // each search-API page (or each import page when importSource is set).
  excludeContent: null,
  excludeMatchMode: "substring", // 'substring' | 'exact' (word-boundary)
  // CSV of channel / thread IDs to keep — every message surfaced from one of
  // these is dropped client-side, so a server-wide wipe can spare a handful of
  // channels. Threads carry their own channel ID in search results, so listing
  // a thread ID spares that thread as well.
  excludeChannels: null,
  excludeLink: null,
  excludeImage: null,
  excludeVideo: null,
  excludeSound: null,
  excludeSticker: null,
  excludePoll: null,
  excludeEmbed: null,
  excludeForward: null,
  excludeMentions: null, // CSV of user IDs (parsed via parseCsvList at filter time)
  excludeMentionEveryone: null,
  excludeExtensions: null, // array of lowercase extensions, no leading dots
  // Pacing / runtime knobs.
  searchDelay: null,
  deleteDelay: null,
  maxEmptyPageRetries: 5, // re-fetch this many times when grandTotal says more remain but the page is empty
  askForConfirmation: true,
  streamerMode: false, // redact message content + author usernames in confirmation preview and per-delete log
  // When set, run() pulls pages from this source's fetchPage() instead of
  // calling Discord's search API. Used by the data-export import flow to
  // skip the search phase entirely. See src/export-import.js#ImportSource.
  importSource: null,
};


// ============================================================================
// END-REASON LABELS
// ----------------------------------------------------------------------------
// Human-readable labels for state.endReason — surfaced in the failure-summary
// branch of run(). 'completed' and 'no-matches' have their own dedicated
// summary branches and are not in this map.
// ============================================================================

const END_REASON_LABELS = {
  "empty-page-exhausted": "空页面重试次数已耗尽",
  "user-stopped": "用户已停止任务",
  "user-declined": "用户拒绝了确认提示",
  "auth-expired": "授权令牌已过期",
  "fetch-error": "网络或服务器错误",
  "api-error": "API 拒绝了请求",
};


// ============================================================================
// UNDISCORD CORE CLASS
// ============================================================================

class UndiscordCore {

  // -------------------- Private state --------------------
  // run() bumps #runId on entry; each loop captures the value at start and
  // exits if it ever differs — a fresh run() has superseded this loop.
  #runId = 0;
  #waitAbort = null; // set while a #wait() is in flight; calling it resolves the wait early
  #beforeTs = 0; // timestamp at request-send, used by afterRequest() for ping calc

  /** Cancellable sleep — stop() resolves this immediately so the loop checks state.running without delay. */
  #wait(ms) {
    return new Promise(resolve => {
      const t = setTimeout(() => {
        this.#waitAbort = null;
        resolve();
      }, ms);
      this.#waitAbort = () => {
        clearTimeout(t);
        this.#waitAbort = null;
        resolve();
      };
    });
  }

  // -------------------- Public configuration / state --------------------

  options = { ...DEFAULT_OPTIONS };

  /**
   * Fresh per-run state. The class field below AND resetState() both consume
   * this factory — they used to be two hand-copied literals, which is exactly
   * how a newly added field can end up missing from the reset path (and
   * resetState() runs before every single job, so that is a guaranteed crash).
   */
  #freshState() {
    return {
      running: false,
      delCount: 0,
      failCount: 0,
      grandTotal: 0,
      offset: 0,
      emptyPageRetry: 0,
      endReason: null, // 'completed' | 'no-matches' | 'empty-page-exhausted' | 'user-stopped' | 'user-declined' | 'auth-expired' | 'fetch-error' | 'api-error'
      _userDeleteDelay: 0, // baseline the user chose; options.deleteDelay decays back toward this after 429 bumps
      _userSearchDelay: 0, // baseline the user chose; options.searchDelay decays back toward this after 429 bumps

      _searchResponse: null,
      _messagesToDelete: [],
      _skippedMessages: [],
      // Threads that answered a delete with an "archived" error during this
      // run. Once a thread lands here, its remaining messages are dropped
      // from the page instead of retried — one dead thread costs one failed
      // request, not one per message.
      _archivedThreadIds: new Set(),
      // Unique IDs of every message skipped at least once this run (keep-list,
      // system messages, archived threads, …) — drives the 跳过 display and
      // the end-of-run accounting line.
      _skippedIds: new Set(),
    };
  }

  state = this.#freshState();

  stats = {
    startTime: null,
    throttledCount: 0,
    throttledTotalTime: 0,
    lastPing: null, // most recent request round-trip; status display only
    avgPing: null, // EMA of lastPing; status display only
    avgPostsInPage: 0, // running mean of deletable posts per page; drives ETR
    pagesProcessed: 0, // count of productive pages observed (for the running mean)
    etr: 0,
  };

  // -------------------- Event hooks --------------------

  onStart = undefined;
  onProgress = undefined;
  onStop = undefined;
  // Fires once per batch iteration BEFORE the per-job run() begins, with the
  // 1-based job index and the batch total. Single-job runs never fire this —
  // the UI defaults to displaying "Job 1/1" instead.
  onJob = undefined;


  // ========================================================================
  // LIFECYCLE
  // ========================================================================

  /** Resets every counter / cursor on `state` to its initial value, ready for a fresh run. The confirmation prompt re-arms (the user is asked again on the next run). */
  resetState() {
    this.state = this.#freshState();
    this.options.askForConfirmation = true;
  }

  /** Resets `options` to DEFAULT_OPTIONS and overlays the caller's partial. Every option lands at a known value on each new run. */
  resetOptions(overrides = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...overrides };
  }

  /** Runs `run()` once per queued (server, channel) target, sequentially. The confirmation prompt only fires on the first job; subsequent jobs proceed silently. */
  async runBatch(queue) {
    if (this.state.running) return log.error("任务已在运行中！");

    log.info(`正在运行批量任务：队列中有 ${queue.length} 个任务`);
    for (let i = 0; i < queue.length; i++) {
      const job = queue[i];
      log.info("开始任务…", `(${i + 1}/${queue.length})`);

      this.options = { ...this.options, ...job };
      if (this.onJob) this.onJob(i + 1, queue.length);

      await this.run(true);
      if (!this.state.running) break;

      log.info("任务结束。", `(${i + 1}/${queue.length})`);
      this.resetState();
      this.options.askForConfirmation = false;
    }

    log.info("批量任务完成。");
    this.state.running = false;
  }

  /** Main delete loop for a single (server, channel) target. Repeats search → filter → confirm (first page only) → delete page → wait, until the search returns empty or stop() fires. */
  async run(inBatch = false) {
    if (this.state.running && !inBatch) return log.error("任务已在运行中！");

    this.#runId++; // any prior loop now sees a stale id and exits
    const myRunId = this.#runId; // captured for this run only
    this.state.running = true;
    this.state._userDeleteDelay = this.options.deleteDelay; // baseline for decay after rate-limit bumps
    this.state._userSearchDelay = this.options.searchDelay;
    this.stats.startTime = new Date();
    // Fresh running mean for the new run — page sizes vary by channel/content.
    this.stats.avgPostsInPage = 0;
    this.stats.pagesProcessed = 0;

    log.success(`\n开始时间：${this.stats.startTime.toLocaleString()}`);

    if (this.onStart) this.onStart(this.state, this.stats);

    do {
      // Bail out if a newer run() has superseded this loop.
      if (this.#runId !== myRunId) {
        log.verb("当前任务已被新任务取代，退出旧循环。");
        return;
      }

      log.verb("正在获取消息…");
      if (this.options.importSource) {
        // Import mode: pull the next page from the in-memory imported list
        // instead of calling Discord's search API. fetchPage() is synchronous
        // and never throws — no rate-limit / network handling needed here.
        this.options.importSource.fetchPage(this);
      } else {
        await this.search();
      }

      // search() can short-circuit on stop during a 202/429 cooldown, returning
      // before _searchResponse is populated. Bail out cleanly in that case.
      if (!this.state.running || this.#runId !== myRunId) return;

      await this.filterResponse();

      log.verb(`总数：${this.state.grandTotal}`);
      log.verb(`当前页消息：${this.state._searchResponse.messages.length}`);
      log.verb(`待删除：${this.state._messagesToDelete.length}`);
      log.verb(`已跳过：${this.state._skippedMessages.length}`);
      log.verb(`偏移量：${this.state.offset}`);
      this.printStats();

      this.calcEtr();
      log.verb(`预计剩余时间：${msToHMS(this.stats.etr)}`);

      if (this.state._messagesToDelete.length > 0) {
        this.state.emptyPageRetry = 0; // got a productive page, reset retry counter

        if (await this.promptConfirmation() === false) {
          this.state.endReason = "user-declined";
          this.state.running = false;
          break;
        }

        await this.deleteMessagesFromList();
        // Stop pressed during the delete loop → exit before the trailing wait.
        if (!this.state.running) break;

        // Last-page short-circuit: when the running totals match grandTotal,
        // skip the trailing wait and the redundant empty-page confirmation
        // search. Page size isn't a reliable signal — Discord pages are
        // content-bounded, so a sub-25 response can happen mid-run on long
        // messages.
        if (this.state.delCount + this.state.failCount >= this.state.grandTotal) {
          this.state.endReason = "completed";
          break;
        }
      }
      else if (this.state._skippedMessages.length > 0) {
        this.state.emptyPageRetry = 0; // got a non-empty page, reset retry counter
        // Page has results but no deletable ones (e.g. all system messages).
        // Advance the offset and try the next page; the loop ends when a
        // fully empty page returns.
        const oldOffset = this.state.offset;
        this.state.offset += this.state._skippedMessages.length;
        log.verb("当前页没有可删除的消息，正在检查下一页…");
        log.verb(`当前页跳过 ${this.state._skippedMessages.length}/${this.state._searchResponse.messages.length} 条消息。`, `（偏移量由 ${oldOffset} 调整为 ${this.state.offset}）`);
      }
      else {
        // Empty page. Decide whether to retry (search index lag is common) or stop (truly done).

        // Import-mode short-circuit: an exhausted ImportSource has emitted
        // every record. There's no search index to wait on, so the empty-page
        // retry budget doesn't apply — finalise immediately.
        if (this.options.importSource && this.options.importSource.exhausted) {
          if (this.state.delCount + this.state.failCount === 0 && this.state.grandTotal === 0) {
            this.state.endReason = "no-matches";
          } else {
            this.state.endReason = "completed";
          }
          if (inBatch) break;
          this.state.running = false;
          break;
        }

        // offset only ever advances past skipped (non-deletable) positions,
        // so subtracting it keeps "expected remaining" honest for runs whose
        // pages are dominated by keep-list / system-message skips. Without it,
        // a wipe whose remaining hits are all in kept channels would burn the
        // full empty-page retry budget before being allowed to finish.
        const expectedRemaining = this.state.grandTotal - (this.state.delCount + this.state.failCount) - this.state.offset;
        const max = this.options.maxEmptyPageRetries;

        if (expectedRemaining > 0 && this.state.emptyPageRetry < max) {
          this.state.emptyPageRetry++;
          log.warn(
            `API 返回空页面，但预计仍有约 ${expectedRemaining} 条消息。`,
            `正在重试（${this.state.emptyPageRetry}/${max}）…`
          );
          // fall through to the trailing searchDelay wait, then loop iterates
        }
        else {
          if (this.state.delCount + this.state.failCount === 0 && this.state.grandTotal === 0) {
            // First search returned zero — the filters didn't match anything
            // in this target. Distinct from a successful run; surfaced as its
            // own end state.
            this.state.endReason = "no-matches";
          } else if (this.state.emptyPageRetry >= max) {
            log.warn(`连续 ${max} 个空页面后停止重试。`, `（按总数仍预计有 ${expectedRemaining} 条消息——可能受搜索索引延迟、偏移量上限或筛选条件影响而无法访问。）`);
            this.state.endReason = "empty-page-exhausted";
          } else {
            this.state.endReason = "completed";
          }
          if (inBatch) break; // break without stopping if this is part of a job
          this.state.running = false;
          break; // skip the trailing searchDelay wait — done
        }
      }

      // Wait before next page — gives Discord's search index time to catch up.
      // Skipped in import mode (no API call to pace).
      if (!this.options.importSource) {
        log.verb(`等待 ${(this.options.searchDelay / 1000).toFixed(2)} 秒后获取下一页…`);
        await this.#wait(this.options.searchDelay);
      }

    } while (this.state.running);

    // If a fresh run() bumped #runId while this loop was waiting, the
    // end-summary and onStop belong to that new run — skip them here.
    // Manual stop() does not bump #runId, so a user-triggered stop falls
    // through to the summary below.
    if (this.#runId !== myRunId) return;

    const endTime = new Date();
    const elapsed = msToHMS(endTime.getTime() - this.stats.startTime.getTime());

    // Pick the end-summary log level/format from how the run ended. Each line
    // gets its own log call so they stack vertically and inherit the level's
    // colour.
    if (this.state.endReason === "no-matches") {
      log.warn("没有找到匹配的消息。");
      log.warn("搜索筛选没有返回结果——当前参数没有匹配的消息。");
      log.warn(`总耗时：${elapsed}`);
    } else if (this.state.endReason === "completed" && this.state.failCount === 0) {
      log.success("任务已成功完成。");
      log.success(`已删除消息：${this.state.delCount}/${this.state.grandTotal}`);
      log.success(`总耗时：${elapsed}`);
    } else if (this.state.endReason === "completed") {
      log.warn("任务完成，但存在失败项。");
      log.warn(`已删除：${this.state.delCount}/${this.state.grandTotal}`);
      log.warn(`失败数量：${this.state.failCount}`);
      log.warn(`总耗时：${elapsed}`);
    } else {
      const mode = END_REASON_LABELS[this.state.endReason] || "未知原因";
      log.error("任务提前失败。");
      log.error(`失败原因：${mode}`);
      log.error(`已删除：${this.state.delCount}/${this.state.grandTotal}`);
      log.error(`总耗时：${elapsed}`);
    }
    if (this.state._skippedIds.size) {
      log.info(`另有 ${this.state._skippedIds.size} 条消息已跳过未删除（排除频道、系统消息、归档帖等）。`);
    }
    this.printStats();

    if (this.onStop) this.onStop(this.state, this.stats);
  }

  /** Aborts the run. Sets state.running=false and wakes any in-flight sleep so the main loop exits at its next checkpoint and prints the end-summary. */
  stop() {
    if (this.state.running) this.state.endReason = "user-stopped";
    this.state.running = false;
    if (this.#waitAbort) this.#waitAbort();
    if (this.onStop) this.onStop(this.state, this.stats);
  }


  // ========================================================================
  // ETR + CONFIRMATION
  // ========================================================================

  /**
   * Estimated time remaining = perPostCost × remaining, where perPostCost is
   * derived from observed page sizes:
   *   perPageCost = searchDelay + (avgPostsInPage * deleteDelay)
   *   perPostCost = perPageCost / avgPostsInPage
   * Uses an avgN of 25 as a starting estimate before any productive page has
   * been observed (Discord's pages are content-bounded so real values often
   * fall lower); the running mean converges within a handful of pages.
   *
   * Ping is intentionally out of this formula — its variance dwarfs
   * deleteDelay on stable connections, and rate-limit bumps are reflected via
   * options.deleteDelay already, so adding ping double-counts during throttle.
   *
   * Import mode: only deleteDelay applies — no per-page search cost — so the
   * formula collapses to (deletes left × delay between deletes).
   */
  calcEtr() {
    const remaining = this.state.grandTotal - this.state.delCount - this.state.failCount;
    if (remaining <= 0) { this.stats.etr = 0; return; }
    if (this.options.importSource) {
      this.stats.etr = remaining * this.options.deleteDelay;
      return;
    }
    const avgN = this.stats.avgPostsInPage > 0 ? this.stats.avgPostsInPage : 25;
    const perPageCost = this.options.searchDelay + (avgN * this.options.deleteDelay);
    this.stats.etr = (perPageCost / avgN) * remaining;
  }

  /** Shows a browser confirm() dialog with the estimated count, ETA, and a content preview. Fires once per run (or once per batch); subsequent pages skip the prompt. Returns true on confirm, false on decline. */
  async promptConfirmation() {
    if (!this.options.askForConfirmation) return true;

    log.verb("等待你的确认…");
    const sm = this.options.streamerMode;
    const preview = this.state._messagesToDelete.map(m => {
      const author = sm ? "••••" : `${m.author?.username ?? "[系统消息]"}#${m.author?.discriminator ?? "0"}`;
      const body = m.attachments?.length ? "[附件]" : (sm ? "••••" : m.content);
      return `${author}: ${body}`;
    }).join("\n");

    const answer = await askYesNo(
      `确定要删除约 ${this.state.grandTotal} 条消息吗？（预计用时：${msToHMS(this.stats.etr)}）` +
      "（实际删除数量可能更少，取决于当前筛选条件）" +
      "\n\n---- 删除预览 ----\n" +
      preview
    );

    if (!answer) {
      log.error("已由你中止！");
      return false;
    }
    else {
      log.verb("已确认");
      this.options.askForConfirmation = false; // do not ask for confirmation again on the next request
      return true;
    }
  }


  // ========================================================================
  // SEARCH
  // ========================================================================

  /** Fetches the next page of matching messages from Discord's search API into `state._searchResponse`. Handles 202 (channel not yet indexed), 429 (rate limit, with delay bump), 401 (auth expired), 5xx (transient retry), and network errors. */
  async search(transientAttempt = 0) {
    const base = this.options.guildId === "@me"
      ? `${API_BASE}/channels/${this.options.channelId}/messages/` // DMs
      : `${API_BASE}/guilds/${this.options.guildId}/messages/`; // Server

    let resp;
    try {
      this.beforeRequest();
      resp = await fetch(base + "search?" + queryString([
        ["author_id", this.options.authorId || undefined],
        // Omit channel_id for DMs (URL already has it) AND for server-wide wipes (empty channelId).
        ["channel_id", (this.options.guildId !== "@me" && this.options.channelId) ? this.options.channelId : undefined],
        ["min_id", this.options.minId ? toSnowflake(this.options.minId) : undefined],
        ["max_id", this.options.maxId ? toSnowflake(this.options.maxId) : undefined],
        ["sort_by", "timestamp"],
        ["sort_order", "desc"],
        ["offset", this.state.offset],
        ["has", this.options.hasLink ? "link" : undefined],
        ["has", this.options.hasImage ? "image" : undefined],
        ["has", this.options.hasVideo ? "video" : undefined],
        ["has", this.options.hasSound ? "sound" : undefined],
        ["has", this.options.hasSticker ? "sticker" : undefined],
        ["has", this.options.hasPoll ? "poll" : undefined],
        ["has", this.options.hasEmbed ? "embed" : undefined],
        ["has", this.options.hasForward ? "snapshot" : undefined],
        ["mentions", this.options.mentions || undefined],
        ["mention_everyone", this.options.mentionEveryone ? true : undefined],
        ["pinned",
          this.options.pinnedMode === "only" ? true :
          this.options.pinnedMode === "exclude" ? false : undefined],
        ["content", this.options.content || undefined],
        // include_nsfw is permissive — when true, age-gated channels return
        // results alongside SFW ones (SFW channels are unaffected). Omitting
        // it (or sending false) silently zero-results NSFW channels in the
        // queue. The "Exclude NSFW channels" checkbox inverts: excludeNsfw=
        // false (default) sends include_nsfw=true; excludeNsfw=true omits
        // the param so NSFW channels return nothing.
        ["include_nsfw", this.options.excludeNsfw ? undefined : true],
      ]), {
        headers: authHeaders(this.options.authToken)
      });
      this.afterRequest();
    } catch (err) {
      // Network error (offline, DNS, etc). Retry with exponential backoff.
      if (transientAttempt < MAX_TRANSIENT_RETRIES) {
        const w = Math.pow(2, transientAttempt) * 1000; // 1s, 2s, 4s
        log.warn(`搜索请求失败（可能是网络问题）。将在 ${w} 毫秒后重试（${transientAttempt + 1}/${MAX_TRANSIENT_RETRIES}）…`, err);
        await this.#wait(w);
        if (!this.state.running) return;
        return await this.search(transientAttempt + 1);
      }
      this.state.endReason = "fetch-error";
      this.state.running = false;
      log.error(`搜索请求连续失败 ${MAX_TRANSIENT_RETRIES + 1} 次：`, err);
      throw err;
    }

    // 202: channel not indexed yet — wait the requested cooldown and retry.
    if (resp.status === 202) {
      let w = (await resp.json()).retry_after * 1000;
      w = w || this.options.searchDelay; // retry_after 0 → use the configured search delay
      this.stats.throttledCount++;
      this.stats.throttledTotalTime += w;
      log.warn(`此频道尚未建立索引。等待 ${w} 毫秒，等待 Discord 完成索引…`);
      await this.#wait(w);
      if (!this.state.running) return;
      return await this.search();
    }

    if (!resp.ok) {
      // 429: rate limited.
      if (resp.status === 429) {
        let w = (await resp.json()).retry_after * 1000;
        w = w || this.options.searchDelay;

        this.stats.throttledCount++;
        this.stats.throttledTotalTime += w;
        // Bump effective delay (monotonic — never lower it). Successful searches decay it back toward the user's baseline.
        this.options.searchDelay = Math.max(this.options.searchDelay, w);
        log.warn(`API 限流 ${w} 毫秒！已将搜索延迟提高到 ${this.options.searchDelay} 毫秒（成功后会逐步恢复到 ${this.state._userSearchDelay} 毫秒）。`);
        this.printStats();
        log.verb(`冷却等待 ${w} 毫秒后重试…`);

        await this.#wait(w);
        if (!this.state.running) return;
        return await this.search();
      }

      // 401: token expired or invalid — no retry. The body says which half failed
      // (bad token vs rejected request shape), so it goes into the log verbatim.
      if (resp.status === 401) {
        this.state.endReason = "auth-expired";
        this.state.running = false;
        log.error(`Discord 会话已过期或授权令牌无效（401）。返回体：${(await resp.text()).slice(0, 200)}`);
        throw resp;
      }

      // 5xx: transient server error. Retry with exponential backoff.
      if (resp.status >= 500 && transientAttempt < MAX_TRANSIENT_RETRIES) {
        const w = Math.pow(2, transientAttempt) * 1000;
        log.warn(`搜索 API 返回状态 ${resp.status}。将在 ${w} 毫秒后重试（${transientAttempt + 1}/${MAX_TRANSIENT_RETRIES}）…`);
        await this.#wait(w);
        if (!this.state.running) return;
        return await this.search(transientAttempt + 1);
      }

      // Anything else: hard error.
      this.state.endReason = (resp.status >= 500) ? "fetch-error" : "api-error";
      this.state.running = false;
      log.error(`搜索消息出错，API 返回状态 ${resp.status}！\n`, await resp.json());
      throw resp;
    }
    const data = await resp.json();

    // Successful search — decay the delay back toward the user's baseline (half-life per success).
    if (this.options.searchDelay > this.state._userSearchDelay) {
      this.options.searchDelay = Math.max(
        this.state._userSearchDelay,
        Math.floor((this.options.searchDelay + this.state._userSearchDelay) / 2)
      );
    }

    this.state._searchResponse = data;
    return data;
  }

  /** Narrows the latest search response down to messages that will actually be deleted: drops system messages, applies the pinned-mode filter, then runs every excludeX post-filter. The remainder lands in `state._messagesToDelete`; everything dropped lands in `state._skippedMessages` so the caller can advance the search offset past them. */
  async filterResponse() {
    const data = this.state._searchResponse;

    // grandTotal locks in the highest total_results ever seen and only ever
    // grows. The per-search total_results shrinks as deletes succeed; the
    // peak value is what the post-loop "deleted N/M" denominator reflects.
    const total = data.total_results;
    if (total > this.state.grandTotal) this.state.grandTotal = total;

    // Search returns conversation context (messages near the matched one);
    // only the message marked hit:true is the actual match. .filter(Boolean)
    // drops any conversation missing a hit.
    const discoveredMessages = data.messages.map(convo => convo.find(message => message.hit === true)).filter(Boolean);

    // Type 0 = regular user message; types 6-21 cover pins, joins, replies, etc.
    // System messages outside that range cannot be deleted via this endpoint.
    let messagesToDelete = discoveredMessages;
    messagesToDelete = messagesToDelete.filter(msg => msg.type === 0 || (msg.type >= 6 && msg.type <= 21));

    // Pinned mode is enforced server-side via the `pinned` query param.
    // Re-filter here as a safety net against stray non-matching responses.
    if (this.options.pinnedMode === "exclude") {
      messagesToDelete = messagesToDelete.filter(msg => !msg.pinned);
    } else if (this.options.pinnedMode === "only") {
      messagesToDelete = messagesToDelete.filter(msg => msg.pinned);
    }

    // Exclude filters — Discord's search API has no "doesn't have" parameter,
    // so these run client-side after the search response comes back. Each one
    // drops messages matching the corresponding has-type.
    const opt = this.options;
    const contentMatch = buildContentMatcher(opt.excludeContent, opt.excludeMatchMode);
    if (contentMatch) {
      messagesToDelete = messagesToDelete.filter(msg => !contentMatch(msg.content));
    }
    if (opt.excludeLink) {
      messagesToDelete = messagesToDelete.filter(msg =>
        !(msg.embeds?.some(e => e.type === "link" || e.type === "article")) &&
        !/https?:\/\//i.test(msg.content || ""));
    }
    if (opt.excludeImage) {
      messagesToDelete = messagesToDelete.filter(msg =>
        !(msg.attachments?.some(a => a.content_type?.startsWith("image/"))));
    }
    if (opt.excludeVideo) {
      messagesToDelete = messagesToDelete.filter(msg =>
        !(msg.attachments?.some(a => a.content_type?.startsWith("video/"))));
    }
    if (opt.excludeSound) {
      messagesToDelete = messagesToDelete.filter(msg =>
        !(msg.attachments?.some(a => a.content_type?.startsWith("audio/"))));
    }
    if (opt.excludeSticker) {
      messagesToDelete = messagesToDelete.filter(msg =>
        !(msg.sticker_items?.length > 0) && !(msg.stickers?.length > 0));
    }
    if (opt.excludePoll) {
      messagesToDelete = messagesToDelete.filter(msg => !msg.poll);
    }
    if (opt.excludeEmbed) {
      messagesToDelete = messagesToDelete.filter(msg => !(msg.embeds?.length > 0));
    }
    if (opt.excludeForward) {
      messagesToDelete = messagesToDelete.filter(msg =>
        !(msg.message_snapshots?.length > 0) && msg.message_reference?.type !== 1);
    }
    if (opt.excludeMentions) {
      // Skip @user is a multi-value list applied client-side, so any number of
      // mentioned users can be skipped per run. (Include @user is single-value
      // because Discord's search `mentions=` param accepts only one ID.)
      const skipIds = parseCsvList(opt.excludeMentions);
      if (skipIds.length) {
        messagesToDelete = messagesToDelete.filter(msg =>
          !(msg.mentions?.some(u => skipIds.includes(u.id))));
      }
    }
    if (opt.excludeMentionEveryone) {
      messagesToDelete = messagesToDelete.filter(msg => !msg.mention_everyone);
    }
    const extensionMatch = buildExtensionMatcher(opt.excludeExtensions);
    if (extensionMatch) {
      messagesToDelete = messagesToDelete.filter(msg => !extensionMatch(msg.attachments));
    }

    // Channel-level exclusions. Two sources feed the same drop:
    //   1. options.excludeChannels — the user's keep-list, applied on every
    //      page of a server-wide wipe.
    //   2. state._archivedThreadIds — threads that already answered a delete
    //      with an "archived" error, so the rest of the page isn't spent
    //      re-attempting messages that cannot be deleted.
    // Threads appear in search results under their own channel_id, so matching
    // on channel_id covers both regular channels and threads (and lets the
    // user paste a thread ID to spare a single thread).
    const rawKeep = opt.excludeChannels;
    const keepChannelIds = new Set(Array.isArray(rawKeep) ? rawKeep : parseCsvList(rawKeep));
    const archiveSkipped = new Set();
    if (keepChannelIds.size || this.state._archivedThreadIds.size) {
      messagesToDelete = messagesToDelete.filter(msg => {
        if (!msg.channel_id) return true;
        if (keepChannelIds.has(msg.channel_id)) return false;
        if (this.state._archivedThreadIds.has(msg.channel_id)) {
          archiveSkipped.add(msg.channel_id);
          return false;
        }
        return true;
      });
      if (archiveSkipped.size) {
        log.verb(`已跳过 ${archiveSkipped.size} 个已归档线程的剩余消息（${[...archiveSkipped].join(", ")}）。`);
      }
    }

    // Skipped messages still count toward the search offset for the next page.
    const skippedMessages = discoveredMessages.filter(msg => !messagesToDelete.find(m => m.id === msg.id));

    this.state._messagesToDelete = messagesToDelete;
    this.state._skippedMessages = skippedMessages;
    // Unique-ID accounting for the 跳过 display / end-of-run summary. Re-shown
    // messages are only counted once, so the number stays honest across the
    // mixed-page re-fetch dynamics.
    for (const m of skippedMessages) this.state._skippedIds.add(m.id);

    // Feed the running mean of deletable posts per page — productive pages
    // only, since skipped-only pages don't follow the (search → N deletes) cost model.
    if (messagesToDelete.length > 0) {
      this.stats.pagesProcessed++;
      this.stats.avgPostsInPage += (messagesToDelete.length - this.stats.avgPostsInPage) / this.stats.pagesProcessed;
    }
  }


  // ========================================================================
  // DELETE
  // ========================================================================

  /** Issues one DELETE per message in the current page, with per-message retry on transient failures and a deleteDelay sleep between each. */
  async deleteMessagesFromList() {
    const myRunId = this.#runId;
    for (let i = 0; i < this.state._messagesToDelete.length; i++) {
      // Stop pressed by user OR a newer run has superseded this one.
      if (this.#runId !== myRunId || !this.state.running) return log.error("已由你停止！");

      const message = this.state._messagesToDelete[i];

      // Streamer-mode redaction lives in the DOM via redactHtml dual-spans;
      // CSS toggles which side is visible. Decoupling redaction from the run-
      // time `streamerMode` option means flipping the checkbox mid-run
      // immediately redacts every already-printed line.
      const author = `${message.author?.username ?? "[system]"}#${message.author?.discriminator ?? "0"}`;
      const content = (message.content ?? "").replace(/\n/g, "↵");
      const attachments = message.attachments?.length
        ? " " + redactHtml(JSON.stringify(message.attachments), "[附件]")
        : "";
      log.debug(
        `[${this.state.delCount + 1}/${this.state.grandTotal}] ` +
        `<sup>${new Date(message.timestamp).toLocaleString()}</sup> ` +
        `<b>${redactHtml(author)}</b>` +
        `: <i>${redactHtml(content)}</i>` +
        attachments,
        `<sup>{ID:${escapeHTML(message.id)}}</sup>`
      );

      let attempt = 0;
      while (attempt < MAX_DELETE_ATTEMPTS) {
        const result = await this.deleteMessage(message);

        if (result === "RETRY") {
          attempt++;
          if (this.#runId !== myRunId) return; // abandon retries on supersede
          log.verb(`将在 ${this.options.deleteDelay} 毫秒后重试…（${attempt}/${MAX_DELETE_ATTEMPTS}）`);
          await this.#wait(this.options.deleteDelay);
        }
        else break;
      }

      // Once a thread is known-dead (archived), drop every remaining message of
      // that thread from the pending list — they would each fail the same way.
      // Runs after the retry loop so transient paths are unaffected.
      const dropped = this.#dropDeadThreadMessages(i, message.channel_id);
      if (dropped) {
        log.verb(`已从当前页移除该归档线程的剩余 ${dropped} 条消息，不再逐条尝试。`);
      }

      this.calcEtr();
      if (this.onProgress) this.onProgress(this.state, this.stats);

      await this.#wait(this.options.deleteDelay);
    }
  }

  /**
   * Removes every still-pending message of `channelId` once that channel has
   * been marked as an archived thread. Returns the number of entries dropped
   * (0 when the channel is fine or nothing else was queued from it).
   *
   * `upTo` is the index of the message that just failed: entries at or before
   * it are kept in place so the caller's loop cursor stays valid. Only the
   * tail is rewritten, which is why this can't simply filter the whole array —
   * doing that would shift the unprocessed messages onto already-visited
   * indices and silently skip them.
   */
  #dropDeadThreadMessages(upTo, channelId) {
    if (!channelId || !this.state._archivedThreadIds.has(channelId)) return 0;
    const list = this.state._messagesToDelete;
    const processed = list.slice(0, upTo + 1);
    const remaining = list.slice(upTo + 1).filter(m => m.channel_id !== channelId);
    const dropped = list.length - processed.length - remaining.length;
    if (dropped) this.state._messagesToDelete = processed.concat(remaining);
    return dropped;
  }

  /** Deletes a single message via DELETE /channels/<id>/messages/<id>. Returns 'OK' (deleted), 'RETRY' (transient — caller may try again), or 'FAILED' (permanent — counted toward failCount). */
  async deleteMessage(message) {
    const API_DELETE_URL = `${API_BASE}/channels/${message.channel_id}/messages/${message.id}`;
    let resp;
    try {
      this.beforeRequest();
      resp = await fetch(API_DELETE_URL, {
        method: "DELETE",
        headers: authHeaders(this.options.authToken),
      });
      this.afterRequest();
    } catch (err) {
      // Network error — let the per-message retry loop try once more.
      log.warn("删除请求发生错误（可能是网络问题），将重试：", err);
      log.verb("相关对象：", escapeHTML(JSON.stringify(message)));
      return "RETRY";
    }

    if (!resp.ok) {
      if (resp.status === 429) {
        // Deleting messages too fast.
        const w = (await resp.json()).retry_after * 1000;
        this.stats.throttledCount++;
        this.stats.throttledTotalTime += w;
        // Bump effective delay (monotonic — never lower it). Successful deletes decay it back toward the user's baseline.
        this.options.deleteDelay = Math.max(this.options.deleteDelay, w);
        log.warn(`API 限流 ${w} 毫秒！已将删除延迟提高到 ${this.options.deleteDelay} 毫秒（成功后会逐步恢复到 ${this.state._userDeleteDelay} 毫秒）。`);
        this.printStats();
        log.verb(`冷却等待 ${w} 毫秒后重试…`);
        await this.#wait(w);
        return "RETRY";
      } else if (resp.status === 401) {
        // Token expired or invalid — abort the whole run, not just this message.
        this.state.endReason = "auth-expired";
        this.state.running = false;
        log.error("Discord 会话已过期或授权令牌无效，请重新加载 Discord 后再试。");
        this.state.failCount++;
        return "FAILED";
      } else if (resp.status >= 500) {
        // Transient server error — retry via the per-message retry loop.
        log.warn(`删除 API 返回状态 ${resp.status}，将重试。`);
        return "RETRY";
      } else {
        const body = await resp.text();

        try {
          const r = JSON.parse(body);

          if (resp.status === 400 && r.code === 50083) {
            // 400 with code 50083 = the thread is archived. The message is
            // unrecoverable through this endpoint; record the thread so both
            // the rest of this page and every later page skip it wholesale
            // instead of burning a request per message. The offset still has
            // to advance (done by the caller for skipped messages) so the
            // same message doesn't reappear on the next search page.
            this.state._archivedThreadIds.add(message.channel_id);
            log.warn(`跳过已归档线程中的消息（线程 ${redactHtml(message.channel_id)}，Discord 拒绝删除已归档线程内容）。`);
            this.state.failCount++;
            return "FAILED";
          }

          log.error(`删除消息出错，API 返回状态 ${resp.status}！`, r);
          log.verb("相关对象：", escapeHTML(JSON.stringify(message)));
          this.state.failCount++;
          return "FAILED";
        } catch (e) {
          log.error(`解析 JSON 失败。API 返回状态 ${resp.status}！`, body);
          this.state.failCount++;
          return "FAILED";
        }
      }
    }

    // Successful delete — decay the delay back toward the user's baseline (half-life per success).
    if (this.options.deleteDelay > this.state._userDeleteDelay) {
      this.options.deleteDelay = Math.max(
        this.state._userDeleteDelay,
        Math.floor((this.options.deleteDelay + this.state._userDeleteDelay) / 2)
      );
    }

    this.state.delCount++;
    return "OK";
  }


  // ========================================================================
  // STATS HELPERS
  // ========================================================================

  /** Records the request-send timestamp so afterRequest() can compute the round-trip ping. */
  beforeRequest() {
    this.#beforeTs = Date.now();
  }

  /** Updates `stats.lastPing` (most recent round-trip) and `stats.avgPing` (EMA, 10% weight on the new sample). */
  afterRequest() {
    this.stats.lastPing = (Date.now() - this.#beforeTs);
    this.stats.avgPing = this.stats.avgPing > 0 ? (this.stats.avgPing * 0.9) + (this.stats.lastPing * 0.1) : this.stats.lastPing;
  }

  /** Logs the current pacing values, ping samples, and rate-limit counters at verbose level. */
  printStats() {
    log.verb(`删除延迟：${this.options.deleteDelay} 毫秒，搜索延迟：${this.options.searchDelay} 毫秒`);
    log.verb(`最近延迟：${this.stats.lastPing} 毫秒，平均延迟：${this.stats.avgPing | 0} 毫秒`);
    log.verb(`触发限流：${this.stats.throttledCount} 次。`);
    log.verb(`限流总耗时：${msToHMS(this.stats.throttledTotalTime)}。`);
  }
}


export default UndiscordCore;
