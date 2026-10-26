/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Version comparison for the "check for updates" row — deliberately the whole
// update story. A userplugin is compiled into dist/vencordDesktopRenderer.js at
// build time, so nothing here can install anything: the plugin cannot rewrite
// its own code while Discord is running (Vencord's own updater is a git pull +
// `node scripts/build/build.mjs` against the Vencord checkout, and it does not
// touch userplugins). All this module does is tell you a newer build exists and
// how to get it.
//
// Pure functions only (no Discord imports), so node can run the truth table:
//   pnpm exec esbuild src/userplugins/undiscordLite/update/updateCheck.ts \
//     --format=cjs --outfile=<tmp>/updateCheck.cjs

/** Where the published copy of version.json lives. `raw.githubusercontent.com` is
 *  connect-src allowed by Vencord's CSP (`src/main/csp/index.ts`), unlike most hosts. */
export const VERSION_URL = "https://raw.githubusercontent.com/Aqua-aries1/undiscordLite/main/version.json";
export const REPO_URL = "https://github.com/Aqua-aries1/undiscordLite";

/** `1.2.3` / `v1.2.3` -> [1, 2, 3]; anything else -> null. Three parts, on purpose:
 *  a two-part version would compare "1.10" and "1.9" as [1,10] vs [1,9] but a
 *  one-part one would silently accept "2" and outrank every 1.x. */
export function parseVersion(text: unknown): [number, number, number] | null {
    const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(String(text ?? "").trim());
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * True only when `remote` is a strictly higher version than `local`.
 * Unparsable input is "not newer" rather than an error: a broken version.json on
 * the other end must never make the UI claim an update exists.
 */
export function isNewer(remote: unknown, local: unknown): boolean {
    const r = parseVersion(remote);
    const l = parseVersion(local);
    if (!r || !l) return false;
    for (let i = 0; i < 3; i++) {
        if (r[i] !== l[i]) return r[i] > l[i];
    }
    return false;
}

export interface UpdateStatus {
    local: string;
    /** null when the fetch or the parse failed — see `error`. */
    remote: string | null;
    newer: boolean;
    notes?: string;
    error?: string;
}

/** One line for the settings row. Kept here so the wording is testable. */
export function describeUpdate(status: UpdateStatus): string {
    if (status.error) return `连不上 GitHub（${status.error}）——不影响插件使用`;
    if (status.remote == null) return "远端 version.json 格式不对，没法比较";
    if (status.newer) return `有新版 v${status.remote}（本机 v${status.local}）`;
    return `已是最新（v${status.local}）`;
}
