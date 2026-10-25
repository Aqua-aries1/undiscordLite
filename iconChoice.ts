/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Pure: decides what a user-typed "自定义图标" string means. No Discord import,
// so the rules can be checked in node without the client:
//
//   pnpm exec esbuild src/userplugins/undiscordLite/iconChoice.ts --format=cjs --outfile=/tmp/iconChoice.cjs
//   node -e 'const i=require("/tmp/iconChoice.cjs"); console.log(i.parseCustomIcon("<a:parrot:123456789012345678>"), i.parseCustomIcon("🦜"), i.parseCustomIcon("复读这条"))'
//
// One function, used twice on purpose: the setting's isValid (so a value that
// can't be drawn is refused at input time, with a visible message) and the
// button renderer. A renderer-only check would silently ignore the setting.

/** A custom Discord emoji, `<:name:id>` or animated `<a:name:id>`. */
const CUSTOM_EMOJI_RE = /^<(a)?:([A-Za-z0-9_]+):(\d{15,25})>$/;

/**
 * Whether the input is at most one or two icon-sized glyphs. Counting code
 * points would misjudge every ZWJ emoji (👨‍👩‍👧 is one glyph, five code
 * points), so real graphemes are counted when the platform can; the code-point
 * ceiling is only the fallback and is set to cover a base char plus its
 * variation selector / skin-tone modifier.
 */
const MAX_GLYPHS = 2;
const MAX_CODE_POINTS_FALLBACK = 4;

function isIconSized(s: string): boolean {
    const Segmenter = (Intl as any)?.Segmenter;
    if (typeof Segmenter === "function")
        return Array.from(new Segmenter("zh", { granularity: "grapheme" }).segment(s)).length <= MAX_GLYPHS;
    return Array.from(s).length <= MAX_CODE_POINTS_FALLBACK;
}

export type CustomIcon =
    | { kind: "emoji"; url: string; name: string; }
    | { kind: "text"; text: string; };

/**
 * Returns what to draw for a raw user input, or null when the input is empty
 * or unusable (caller falls back to the preset icon).
 */
export function parseCustomIcon(raw: string | null | undefined): CustomIcon | null {
    const s = String(raw ?? "").trim();
    if (!s) return null;

    const m = CUSTOM_EMOJI_RE.exec(s);
    if (m) {
        // `size=32` so it stays crisp when Discord scales the 18px toolbar slot.
        return { kind: "emoji", name: m[2], url: `https://cdn.discordapp.com/emojis/${m[3]}.${m[1] ? "gif" : "png"}?size=32` };
    }

    if (!isIconSized(s)) return null;
    // A lone "<" or "&" would be the user mid-typing an emoji tag; refuse it
    // rather than render a stray bracket on the button.
    if (/[<>&]/.test(s)) return null;
    return { kind: "text", text: s };
}
