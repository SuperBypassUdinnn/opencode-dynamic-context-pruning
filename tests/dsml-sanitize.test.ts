import assert from "node:assert/strict"
import test from "node:test"
import type { WithParts } from "../lib/state"
import {
    removeOrphanTagLines,
    sanitizeLeakedMarkup,
    sanitizeLeakedMarkupFromString,
    stripDsmlTags,
    truncateRepeatedLines,
} from "../lib/messages/dsml-sanitize"
import { stripHallucinations } from "../lib/messages/utils"

const SANITIZE_PLACEHOLDER = "[... leaked tool-call serialization removed ...]"

const makeMessage = (role: "user" | "assistant", parts: any[]): WithParts =>
    ({
        info: {
            id: `msg_${role}`,
            sessionID: "ses_test",
            role,
            agent: "build",
            model: { providerID: "nvidia", modelID: "deepseek-ai/deepseek-v4.1-flash" },
            time: { created: 0 },
        },
        parts,
    }) as unknown as WithParts

const textPart = (text: string) => ({
    id: "prt_text",
    sessionID: "ses_test",
    messageID: "msg_assistant",
    type: "text" as const,
    text,
})

const reasoningPart = (text: string) => ({
    id: "prt_reasoning",
    sessionID: "ses_test",
    messageID: "msg_assistant",
    type: "reasoning" as const,
    text,
    time: { start: 0 },
})

const toolPart = (output: string) => ({
    id: "prt_tool",
    sessionID: "ses_test",
    messageID: "msg_assistant",
    type: "tool" as const,
    callID: "call_test",
    tool: "bash",
    state: { status: "completed" as const, output },
})

test("stripDsmlTags removes full-width-bar DSML tags", () => {
    assert.equal(stripDsmlTags("a\n<｜DSML｜ invoke>\nb"), "a\n\nb")
    assert.equal(stripDsmlTags("x</｜DSML｜ parameter>y"), "xy")
    assert.equal(stripDsmlTags("x</｜DSML｜ calls>y"), "xy")
    assert.equal(stripDsmlTags('<｜DSML｜invoke name="compress">'), "")
    assert.equal(stripDsmlTags("truncated tail <｜DSML｜"), "truncated tail ")
    assert.equal(stripDsmlTags("clean text"), "clean text")
})

test("truncateRepeatedLines collapses runs beyond the cap and keeps a marker", () => {
    const degenerate = Array.from({ length: 10056 }, () => "</invoke>").join("\n")
    const { text, removed } = truncateRepeatedLines(degenerate)
    assert.equal(removed, 10056 - 3)
    const lines = text.split("\n")
    assert.equal(lines.length, 4)
    assert.ok(lines.every((line, index) => index < 3 || line.includes("truncated")))

    // At or below the cap the text is untouched.
    const acceptable = Array.from({ length: 50 }, () => "same line").join("\n")
    assert.deepEqual(truncateRepeatedLines(acceptable), { text: acceptable, removed: 0 })

    // Non-adjacent duplicates are not collapsed.
    const scattered = "a\nb\na\nb\na"
    assert.deepEqual(truncateRepeatedLines(scattered), { text: scattered, removed: 0 })
})

test("removeOrphanTagLines only reacts to degenerate standalone markup", () => {
    const degenerate = Array.from({ length: 124 }, () => "</invoke>").join("\n")
    const { text, removed } = removeOrphanTagLines(degenerate)
    assert.equal(removed, 124)
    assert.ok(text.includes("leaked tool-call markup lines removed"))
    assert.ok(!text.includes("</invoke>"))

    // A few isolated quotes are legitimate and must survive.
    const quoted = "Example:\n</invoke>\nDone"
    assert.deepEqual(removeOrphanTagLines(quoted), { text: quoted, removed: 0 })

    // Inline occurrences (not standalone lines) always survive.
    const inline = Array.from({ length: 20 }, (_, i) => `step ${i} wrote </invoke> mid-line`).join(
        "\n",
    )
    assert.deepEqual(removeOrphanTagLines(inline), { text: inline, removed: 0 })
})

test("sanitizeLeakedMarkupFromString cleans a realistic DSML leak", () => {
    const leak = [
        "I will compress the conversation.",
        '<parameter name="topic">Auth exploration</parameter>',
        "</｜DSML｜ parameter>",
        "</｜DSML｜ invoke>",
        "</｜DSML｜ calls>",
        ...Array.from({ length: 10056 }, () => "</invoke>"),
    ].join("\n")

    const result = sanitizeLeakedMarkupFromString(leak)
    assert.ok(result.includes("I will compress the conversation."))
    assert.ok(!result.includes("</invoke>"))
    assert.ok(!result.includes("｜DSML｜"))
    assert.ok(result.includes("leaked tool-call markup lines removed"))
    assert.ok(result.length < 500)
})

test("sanitizeLeakedMarkupFromString collapses plain-text repetition loops", () => {
    const loop = Array.from({ length: 200 }, () => "I need to call the compress tool").join("\n")
    const result = sanitizeLeakedMarkupFromString(loop)
    const lines = result.split("\n")
    assert.equal(lines.length, 4)
    assert.ok(result.includes("197 identical lines truncated"))
})

test("sanitizeLeakedMarkupFromString keeps normal prose and code samples intact", () => {
    const code = [
        "Here is the leaked call format:",
        "```xml",
        '<invoke name="compress">',
        '<parameter name="topic">t</parameter>',
        "</invoke>",
        "```",
        "That is how DeepSeek serializes calls.",
    ].join("\n")
    assert.equal(sanitizeLeakedMarkupFromString(code), code)
})

test("sanitizeLeakedMarkupFromString replaces fully-stripped parts with a placeholder", () => {
    const onlyTags = "</｜DSML｜ invoke>\n</｜DSML｜ calls>"
    assert.equal(sanitizeLeakedMarkupFromString(onlyTags), SANITIZE_PLACEHOLDER)
})

test("sanitizeLeakedMarkup cleans assistant reasoning and text but not user or tool parts", () => {
    const degenerate = Array.from({ length: 80 }, () => "</｜DSML｜ invoke>").join("\n")
    const toolNoise = Array.from({ length: 80 }, () => "log line").join("\n")
    const userNoise = Array.from({ length: 80 }, () => "pasted line").join("\n")

    const messages = [
        makeMessage("assistant", [
            reasoningPart(`thinking...\n${degenerate}`),
            textPart(`answer\n${degenerate}`),
            toolPart(toolNoise),
        ]),
        makeMessage("user", [textPart(userNoise)]),
    ]

    sanitizeLeakedMarkup(messages)

    const [assistant, user] = messages
    const [reasoning, text, tool] = assistant.parts
    assert.ok(!reasoning.text.includes("｜DSML｜"))
    // The DSML-only run strips to empty lines, which the repetition cap collapses.
    assert.ok(reasoning.text.includes("77 identical lines truncated"))
    assert.ok(!text.text.includes("｜DSML｜"))
    // Real tool output may legitimately repeat lines; only DSML tags are stripped there.
    assert.equal(tool.state.output, toolNoise)
    // User content is never repetition-truncated.
    assert.equal(user.parts[0].text, userNoise)
})

test("sanitizeLeakedMarkup is idempotent", () => {
    const degenerate = Array.from({ length: 10056 }, () => "</invoke>").join("\n")
    const messages = [makeMessage("assistant", [textPart(`summary\n${degenerate}`)])]

    sanitizeLeakedMarkup(messages)
    const once = messages[0].parts[0].text
    sanitizeLeakedMarkup(messages)
    assert.equal(messages[0].parts[0].text, once)
})

test("stripHallucinations integrates the leak sanitizer", () => {
    const degenerate = Array.from({ length: 200 }, () => "</invoke>").join("\n")
    const messages = [
        makeMessage("assistant", [
            reasoningPart(`reasoning\n</｜DSML｜ parameter>\n${degenerate}`),
            textPart("final answer"),
        ]),
    ]

    stripHallucinations(messages)

    const reasoning = messages[0].parts[0].text
    assert.ok(!reasoning.includes("｜DSML｜"))
    assert.ok(!reasoning.includes("</invoke>"))
    assert.ok(reasoning.startsWith("reasoning"))
    assert.equal(messages[0].parts[1].text, "final answer")
})

test("stripDsmlTags catches a truncated tag at any line end", () => {
    const partial = "reasoning start\n<｜DSML｜ invoke\nmore text\n<｜DSML｜ param"
    const result = stripDsmlTags(partial)
    assert.equal(result, "reasoning start\n\nmore text\n")
})

test("stripHallucinations leaves user message text untouched", () => {
    const pasted = [
        "Look at this leak I captured:",
        "</｜DSML｜ invoke>",
        "</invoke>",
        "</parameter>",
        "</｜DSML｜ parameter>",
    ].join("\n")
    const messages = [makeMessage("user", [textPart(pasted)])]

    stripHallucinations(messages)

    assert.equal(messages[0].parts[0].text, pasted)
})
