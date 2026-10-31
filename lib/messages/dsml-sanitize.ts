import type { WithParts } from "../state"

/**
 * DeepSeek models serialize tool calls with internal DSML markup built on a
 * full-width vertical bar (U+FF5C, e.g. `</｜DSML｜parameter>`). When the
 * provider fails to parse those segments, the raw markup leaks into the
 * assistant's text or reasoning output and can degenerate into thousands of
 * repeated closing tags. The leaked fragments stay in history and re-prime
 * the same leak on every later turn, so they are cleaned before the
 * conversation is resent to the provider.
 */

// DSML tags never legitimately appear in content, so they are stripped
// unconditionally wherever the from-string sanitizer runs. The second
// pattern catches a tag truncated mid-stream at the end of any line.
const DSML_TAG_REGEX = /<\/?｜DSML｜[^>]*>/g
const DSML_TRUNCATED_TAG_REGEX = /<｜DSML｜[^>\n]*$/gm

// Orphan tool-call markup that leaked as plain text. Only standalone lines
// are considered, and only removed when a part is clearly degenerate.
const STANDALONE_ORPHAN_TAG_REGEX =
    /^[ \t]*<\/?(?:invoke|parameter|parameter_value)(?:[ \t][^>]*)?>[ \t]*$/

// A run of identical consecutive lines is collapsed once it exceeds this
// many repetitions; degenerate loops grow into the thousands.
const MAX_REPEATED_LINES = 50
const KEPT_REPEATED_LINES = 3

// Standalone orphan markup lines are only removed above this count; isolated
// occurrences can be legitimate quotes of tool-call syntax.
const ORPHAN_TAG_LINE_THRESHOLD = 10

const SANITIZE_PLACEHOLDER = "[... leaked tool-call serialization removed ...]"

export const stripDsmlTags = (text: string): string =>
    text.replace(DSML_TAG_REGEX, "").replace(DSML_TRUNCATED_TAG_REGEX, "")

export const truncateRepeatedLines = (text: string): { text: string; removed: number } => {
    const lines = text.split("\n")
    const kept: string[] = []
    let removedTotal = 0

    for (let i = 0; i < lines.length; ) {
        let runEnd = i + 1
        while (runEnd < lines.length && lines[runEnd] === lines[i]) runEnd++
        const runLength = runEnd - i

        if (runLength > MAX_REPEATED_LINES) {
            const removed = runLength - KEPT_REPEATED_LINES
            for (let k = 0; k < KEPT_REPEATED_LINES; k++) kept.push(lines[i])
            kept.push(`[... ${removed} identical lines truncated ...]`)
            removedTotal += removed
        } else {
            for (let k = 0; k < runLength; k++) kept.push(lines[i])
        }
        i = runEnd
    }

    if (removedTotal === 0) {
        return { text, removed: 0 }
    }
    return { text: kept.join("\n"), removed: removedTotal }
}

export const removeOrphanTagLines = (text: string): { text: string; removed: number } => {
    const lines = text.split("\n")
    const orphanIndexes: number[] = []
    for (let i = 0; i < lines.length; i++) {
        if (STANDALONE_ORPHAN_TAG_REGEX.test(lines[i])) {
            orphanIndexes.push(i)
        }
    }

    if (orphanIndexes.length <= ORPHAN_TAG_LINE_THRESHOLD) {
        return { text, removed: 0 }
    }

    const orphanSet = new Set(orphanIndexes)
    const kept = lines.filter((_, index) => !orphanSet.has(index))
    kept.push(`[... ${orphanIndexes.length} leaked tool-call markup lines removed ...]`)
    return { text: kept.join("\n"), removed: orphanIndexes.length }
}

/**
 * Full cleanup for a single assistant text/reasoning string: DSML tags are
 * always stripped, degenerate repetition is collapsed, and orphan markup
 * lines are removed once a part is clearly degenerate.
 */
export const sanitizeLeakedMarkupFromString = (text: string): string => {
    const original = text
    let result = stripDsmlTags(text)
    result = removeOrphanTagLines(result).text
    result = truncateRepeatedLines(result).text

    if (!result.trim() && original.trim()) {
        return SANITIZE_PLACEHOLDER
    }
    return result
}

/**
 * Cleans leaked tool-call serialization from assistant history before it is
 * resent to the provider. Reasoning and text parts get the full treatment;
 * tool outputs are left to the caller because real command output may
 * legitimately contain repeated lines.
 */
export const sanitizeLeakedMarkup = (messages: WithParts[]): void => {
    for (const message of messages) {
        if (message.info.role !== "assistant") {
            continue
        }
        for (const part of message.parts) {
            if (
                (part.type === "text" || part.type === "reasoning") &&
                typeof part.text === "string"
            ) {
                part.text = sanitizeLeakedMarkupFromString(part.text)
            }
        }
    }
}
