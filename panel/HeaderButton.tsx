/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findComponentByCodeLazy } from "@webpack";

import { togglePanel } from "./ui";

const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

// Trash glyph reused from the userscript's server-bar button.
function UndiscordIcon() {
    return (
        <svg
            stroke="currentColor"
            fill="none"
            strokeWidth="0"
            viewBox="0 0 24 24"
            height={24}
            width={24}
            xmlns="http://www.w3.org/2000/svg"
        >
            <path fill="currentColor" d="M15 3.999V2H9V3.999H3V5.999H21V3.999H15Z" />
            <path fill="currentColor" d="M5 6.99902V18.999C5 20.101 5.897 20.999 7 20.999H17C18.103 20.999 19 20.101 19 18.999V6.99902H5ZM11 17H9V11H11V17ZM15 17H13V11H15V17Z" />
        </svg>
    );
}

export function OpenUndiscordButton() {
    return (
        <HeaderBarIcon
            className="vc-undiscord-btn"
            onClick={() => togglePanel()}
            tooltip={"批量删除消息（Ctrl+Shift+D）"}
            icon={UndiscordIcon}
        />
    );
}
