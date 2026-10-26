/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The settings-page row that says which version this build is and whether the
// published one is newer. It is the ONLY part of this plugin that talks to the
// network on its own, and it only does so when the plugin's settings page is
// actually rendered — there is no background timer and no polling.
//
// It cannot update anything. See updateCheck.ts for why.

import { Button } from "@components/Button";
import { React, useEffect, useState } from "@webpack/common";

import pkg from "../version.json";
import { describeUpdate, isNewer, REPO_URL, UpdateStatus, VERSION_URL } from "./updateCheck";

/** The version baked into this build. Same file the check downloads from GitHub,
 *  so there is one number instead of a constant that can drift from the tag. */
export const LOCAL_VERSION: string = pkg.version;

export function UpdateRow() {
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<UpdateStatus | null>(null);

    async function check() {
        setBusy(true);
        try {
            // Cache-busting query: raw.githubusercontent.com sits behind a CDN that
            // keeps a copy for a few minutes, and "no new version" right after a
            // release is the one wrong answer that looks like a bug.
            const res = await fetch(`${VERSION_URL}?t=${Date.now()}`, { cache: "no-store" });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const remote = typeof data?.version === "string" ? data.version.trim() : null;
            setStatus({
                local: LOCAL_VERSION,
                remote,
                newer: isNewer(remote, LOCAL_VERSION),
                notes: typeof data?.notes === "string" ? data.notes : undefined
            });
        } catch (err) {
            setStatus({
                local: LOCAL_VERSION,
                remote: null,
                newer: false,
                error: err instanceof Error ? err.message : String(err)
            });
        } finally {
            setBusy(false);
        }
    }

    useEffect(() => {
        // Runs once per mount (i.e. per settings-page open). `check` is recreated
        // every render; re-running the effect on that identity would loop.
        void check();
    }, []);

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 600 }}>版本 v{LOCAL_VERSION}</span>
                <span style={{ opacity: 0.8 }}>{status ? describeUpdate(status) : "检查中…"}</span>
                <Button
                    size="small"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void check()}
                >
                    {busy ? "检查中…" : "重新检查"}
                </Button>
            </div>
            {status?.newer && (
                <div style={{ fontSize: 12, lineHeight: 1.6, opacity: 0.9 }}>
                    {status.notes ? <>新版说明：{status.notes}<br /></> : null}
                    更新方法：在 <code>src/userplugins/undiscordLite</code> 里执行
                    {" "}<code>git pull</code>，再到 Vencord 目录跑 <code>pnpm build</code>，然后重启 Discord。
                    {" "}<a href={REPO_URL} target="_blank" rel="noreferrer">{REPO_URL}</a>
                </div>
            )}
        </div>
    );
}
