import { describe, expect, it } from "vitest";
import {
  ANSWER_MAX_CHARS,
  answerSimilarity,
  type CardQualityCheckId,
  type CardQualitySeverity,
  CLOZE_DELETION_MAX_WORDS,
  CLOZE_MAX_WORDS,
  CODE_MAX_LINES,
  detectInterference,
  evaluateCardQuality,
  LIST_ITEM_WARN_COUNT,
  LONG_AUDIO_CLIP_MS,
  MAX_CLOZE_DELETIONS,
  PROMPT_MAX_CHARS,
  parseCloze,
} from "./index";

/**
 * Card-quality heuristic tests (T035).
 *
 * Each check fires on the right input and stays silent (`ok`) otherwise:
 *  - a clean short Q&A with a source returns all `ok`;
 *  - an over-long prompt / over-long (multi-fact) answer warns;
 *  - a 2-cloze text warns "multiple clozes";
 *  - an empty answer and a no-deletion cloze return a `block`;
 *  - a missing source warns;
 *  - the ambiguous-pronoun heuristic fires on "It increases this." and not on a
 *    clear sentence.
 * Thresholds are asserted against the exported constants so the UI / M17 / tests
 * never drift apart.
 */

/** Find a check by id (throws if absent — every report has a row per heuristic). */
function check(
  report: ReturnType<typeof evaluateCardQuality>,
  id: CardQualityCheckId,
): { id: CardQualityCheckId; severity: CardQualitySeverity; message: string } {
  const found = report.checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check with id ${id}`);
  return found;
}

describe("evaluateCardQuality — Q&A", () => {
  it("a clean short Q&A with a source is all ok (no warn, no block)", () => {
    const report = evaluateCardQuality({
      kind: "qa",
      prompt: "How does Chollet define intelligence?",
      answer: "As skill-acquisition efficiency.",
      hasSource: true,
    });
    expect(report.hasBlocker).toBe(false);
    expect(report.hasWarning).toBe(false);
    expect(report.checks.every((c) => c.severity === "ok")).toBe(true);
  });

  it("blocks an empty answer (hollow card)", () => {
    const report = evaluateCardQuality({
      kind: "qa",
      prompt: "What is X?",
      answer: "   ",
      hasSource: true,
    });
    expect(report.hasBlocker).toBe(true);
    expect(check(report, "empty").severity).toBe("block");
  });

  it("blocks an empty prompt and an entirely empty card", () => {
    expect(
      check(evaluateCardQuality({ kind: "qa", prompt: "", answer: "A.", hasSource: true }), "empty")
        .severity,
    ).toBe("block");
    expect(
      evaluateCardQuality({ kind: "qa", prompt: "", answer: "", hasSource: true }).hasBlocker,
    ).toBe(true);
  });

  it("warns when the prompt exceeds PROMPT_MAX_CHARS but not at the threshold", () => {
    const atLimit = "x".repeat(PROMPT_MAX_CHARS);
    const overLimit = "x".repeat(PROMPT_MAX_CHARS + 1);
    expect(
      check(
        evaluateCardQuality({ kind: "qa", prompt: atLimit, answer: "A.", hasSource: true }),
        "prompt-too-long",
      ).severity,
    ).toBe("ok");
    expect(
      check(
        evaluateCardQuality({ kind: "qa", prompt: overLimit, answer: "A.", hasSource: true }),
        "prompt-too-long",
      ).severity,
    ).toBe("warn");
  });

  it("warns when the answer exceeds ANSWER_MAX_CHARS (multiple facts)", () => {
    const atLimit = "y".repeat(ANSWER_MAX_CHARS);
    const overLimit = "y".repeat(ANSWER_MAX_CHARS + 1);
    expect(
      check(
        evaluateCardQuality({ kind: "qa", prompt: "Q?", answer: atLimit, hasSource: true }),
        "answer-too-long",
      ).severity,
    ).toBe("ok");
    expect(
      check(
        evaluateCardQuality({ kind: "qa", prompt: "Q?", answer: overLimit, hasSource: true }),
        "answer-too-long",
      ).severity,
    ).toBe("warn");
  });

  it("warns on a missing source and stays ok when a source is attached", () => {
    expect(
      check(
        evaluateCardQuality({ kind: "qa", prompt: "Q?", answer: "A.", hasSource: false }),
        "missing-source",
      ).severity,
    ).toBe("warn");
    expect(
      check(
        evaluateCardQuality({ kind: "qa", prompt: "Q?", answer: "A.", hasSource: true }),
        "missing-source",
      ).severity,
    ).toBe("ok");
  });

  it("warns on a leading ambiguous pronoun and not on a clear sentence", () => {
    expect(
      check(
        evaluateCardQuality({
          kind: "qa",
          prompt: "What happens?",
          answer: "It increases this.",
          hasSource: true,
        }),
        "ambiguous-pronoun",
      ).severity,
    ).toBe("warn");
    expect(
      check(
        evaluateCardQuality({
          kind: "qa",
          prompt: "What does deep sleep do to memory?",
          answer: "Deep sleep consolidates memory.",
          hasSource: true,
        }),
        "ambiguous-pronoun",
      ).severity,
    ).toBe("ok");
  });
});

describe("evaluateCardQuality — cloze", () => {
  it("a single short cloze with a source is all ok", () => {
    const report = evaluateCardQuality({
      kind: "cloze",
      cloze: "Intelligence is {{c1::skill-acquisition efficiency}}.",
      hasSource: true,
    });
    expect(report.hasBlocker).toBe(false);
    expect(report.hasWarning).toBe(false);
    expect(report.checks.every((c) => c.severity === "ok")).toBe(true);
  });

  it("blocks a cloze with no deletion", () => {
    const report = evaluateCardQuality({
      kind: "cloze",
      cloze: "No deletion here at all.",
      hasSource: true,
    });
    expect(report.hasBlocker).toBe(true);
    expect(check(report, "empty").severity).toBe("block");
  });

  it("warns 'multiple clozes' beyond MAX_CLOZE_DELETIONS distinct deletions", () => {
    const single = evaluateCardQuality({
      kind: "cloze",
      cloze: "Memory moves to the {{c1::neocortex}}.",
      hasSource: true,
    });
    expect(check(single, "multiple-clozes").severity).toBe("ok");

    const text = "Memory moves from the {{c1::hippocampus}} to the {{c2::neocortex}}.";
    expect(parseCloze(text).clozeCount).toBeGreaterThan(MAX_CLOZE_DELETIONS);
    const multi = evaluateCardQuality({ kind: "cloze", cloze: text, hasSource: true });
    expect(check(multi, "multiple-clozes").severity).toBe("warn");
  });

  it("counts grouped clozes (repeated c1) as one distinct deletion", () => {
    const report = evaluateCardQuality({
      kind: "cloze",
      cloze: "The {{c1::hippocampus}} talks to the {{c1::hippocampus}} region.",
      hasSource: true,
    });
    expect(check(report, "multiple-clozes").severity).toBe("ok");
  });

  it("warns on a giant cloze paragraph (over CLOZE_MAX_WORDS words)", () => {
    const longBody = `${"word ".repeat(CLOZE_MAX_WORDS + 5)}{{c1::answer}}`;
    expect(
      check(
        evaluateCardQuality({ kind: "cloze", cloze: longBody, hasSource: true }),
        "answer-too-long",
      ).severity,
    ).toBe("warn");
  });

  it("accepts a pre-parsed model instead of re-parsing", () => {
    const cloze = "Intelligence is {{c1::skill-acquisition efficiency}}.";
    const parsed = parseCloze(cloze);
    const report = evaluateCardQuality({ kind: "cloze", cloze, parsed, hasSource: true });
    expect(check(report, "empty").severity).toBe("ok");
    expect(report.hasBlocker).toBe(false);
  });
});

/**
 * Code-aware card-quality checks (T072).
 *
 * A code body is judged in LINES (not chars/words) so the existing thresholds do not
 * over-warn on legitimate code, and the ambiguous-pronoun heuristic is skipped for
 * code (meaningless there).
 */
describe("evaluateCardQuality — code-aware (T072)", () => {
  /** A fenced code block of `n` lines (each a realistically-long statement). */
  const codeFence = (n: number, lang = "python") =>
    [
      `\`\`\`${lang}`,
      ...Array.from(
        { length: n },
        (_, i) => `result_variable_${i} = compute_something_useful(input_${i}, factor=${i})`,
      ),
      "```",
    ].join("\n");

  it("a short code Q&A answer is ok on the LINE threshold (not the char threshold)", () => {
    // This code answer is well over ANSWER_MAX_CHARS in characters, but only a few
    // lines — the char threshold must NOT fire; the line check must say ok.
    const answer = codeFence(4);
    expect(answer.length).toBeGreaterThan(ANSWER_MAX_CHARS);
    const report = evaluateCardQuality({
      kind: "qa",
      prompt: "What does this script set up?",
      answer,
      hasSource: true,
    });
    const lengthRow = check(report, "answer-too-long");
    expect(lengthRow.severity).toBe("ok");
    expect(lengthRow.message).toMatch(/line/i);
    expect(report.hasWarning).toBe(false);
  });

  it("warns when a code answer exceeds CODE_MAX_LINES lines", () => {
    const answer = codeFence(CODE_MAX_LINES + 3);
    const report = evaluateCardQuality({
      kind: "qa",
      prompt: "What does this module do?",
      answer,
      hasSource: true,
    });
    const lengthRow = check(report, "answer-too-long");
    expect(lengthRow.severity).toBe("warn");
    expect(lengthRow.message).toMatch(/code/i);
  });

  it("skips the ambiguous-pronoun heuristic for a code body", () => {
    // The answer is code that begins with `this` (a code identifier), which the prose
    // heuristic would otherwise flag — for a code body it must be skipped entirely.
    const report = evaluateCardQuality({
      kind: "qa",
      prompt: "```js\nthis.x = 1;\n```",
      answer: "```js\nthis.value = compute();\n```",
      hasSource: true,
    });
    expect(report.checks.find((c) => c.id === "ambiguous-pronoun")).toBeUndefined();
  });

  it("judges a code CLOZE fill-in by lines and skips the word/pronoun checks", () => {
    // A code cloze: a fenced block with a `{{c1::…}}` inside. Few lines → ok.
    const cloze = "```python\nw = w - {{c1::lr}} * grad\n```";
    const report = evaluateCardQuality({ kind: "cloze", cloze, hasSource: true });
    const lengthRow = check(report, "answer-too-long");
    expect(lengthRow.severity).toBe("ok");
    expect(lengthRow.message).toMatch(/line/i);
    expect(report.checks.find((c) => c.id === "ambiguous-pronoun")).toBeUndefined();
    // The deletion still counts (not hollow).
    expect(check(report, "empty").severity).toBe("ok");
  });

  it("a normal short prose card still uses the char/word checks (no code regression)", () => {
    const report = evaluateCardQuality({
      kind: "qa",
      prompt: "How is intelligence defined?",
      answer: "As skill-acquisition efficiency.",
      hasSource: true,
    });
    expect(check(report, "answer-too-long").message).not.toMatch(/line/i);
    expect(report.checks.find((c) => c.id === "ambiguous-pronoun")).toBeDefined();
  });
});

describe("evaluateCardQuality — audio cards (T075)", () => {
  it("does NOT flag an audio-prompt card with an empty TEXT prompt (the audio is the prompt)", () => {
    const report = evaluateCardQuality({
      kind: "qa",
      prompt: "", // no written prompt — the looped clip IS the prompt
      answer: "the written translation",
      hasSource: true,
      hasMediaPrompt: true,
      audioClipMs: 4000,
    });
    // Not hollow: the audio carries the prompt face, the written answer the answer face.
    expect(check(report, "empty").severity).toBe("ok");
    expect(report.hasBlocker).toBe(false);
  });

  it("does NOT flag an audio-answer card with an empty TEXT answer", () => {
    const report = evaluateCardQuality({
      kind: "qa",
      prompt: "How is this phrase pronounced?",
      answer: "", // no written answer — the looped clip IS the answer
      hasSource: true,
      hasMediaAnswer: true,
      audioClipMs: 3000,
    });
    expect(check(report, "empty").severity).toBe("ok");
    expect(report.hasBlocker).toBe(false);
  });

  it("STILL blocks an audio-prompt card whose written ANSWER is empty (audio covers only the prompt)", () => {
    const report = evaluateCardQuality({
      kind: "qa",
      prompt: "",
      answer: "", // neither the audio (prompt-only) nor text fills the answer
      hasSource: true,
      hasMediaPrompt: true,
      audioClipMs: 4000,
    });
    expect(check(report, "empty").severity).toBe("block");
    expect(report.hasBlocker).toBe(true);
  });

  it("warns on a long audio clip (> 30 s) and is silent on a short one", () => {
    const longReport = evaluateCardQuality({
      kind: "qa",
      prompt: "",
      answer: "translation",
      hasSource: true,
      hasMediaPrompt: true,
      audioClipMs: LONG_AUDIO_CLIP_MS + 5000,
    });
    const longRow = check(longReport, "long-audio-clip");
    expect(longRow.severity).toBe("warn");
    expect(longRow.message).toMatch(/short/i);

    const shortReport = evaluateCardQuality({
      kind: "qa",
      prompt: "",
      answer: "translation",
      hasSource: true,
      hasMediaPrompt: true,
      audioClipMs: 4000,
    });
    expect(check(shortReport, "long-audio-clip").severity).toBe("ok");
  });

  it("adds NO long-audio-clip row for a text card (no audioClipMs signal)", () => {
    const report = evaluateCardQuality({
      kind: "qa",
      prompt: "How is intelligence defined?",
      answer: "As skill-acquisition efficiency.",
      hasSource: true,
    });
    expect(report.checks.find((c) => c.id === "long-audio-clip")).toBeUndefined();
  });
});

/**
 * Minimum-information-principle checks (T086).
 *
 * Each new heuristic fires on the right input and stays `ok` otherwise, and NONE ever
 * produces a `block` (only the hollow-card `empty` blocks). The existing T035/T072/T075
 * checks above are unchanged.
 */
describe("evaluateCardQuality — T086 minimum-information checks", () => {
  it("multiple-facts: a two-sentence answer warns; a single atomic answer is ok", () => {
    const multi = evaluateCardQuality({
      kind: "qa",
      prompt: "What did the study find?",
      answer: "Sleep consolidates memory. Caffeine blocks adenosine.",
      hasSource: true,
    });
    expect(check(multi, "multiple-facts").severity).toBe("warn");

    const single = evaluateCardQuality({
      kind: "qa",
      prompt: "What does deep sleep do to memory?",
      answer: "It consolidates memory.",
      hasSource: true,
    });
    expect(check(single, "multiple-facts").severity).toBe("ok");
  });

  it("multiple-facts: a SHORT two-clause answer joined by 'and' still warns (count, not length)", () => {
    const report = evaluateCardQuality({
      kind: "qa",
      prompt: "Compare the two regions",
      answer: "Hippocampus encodes, and neocortex stores.",
      hasSource: true,
    });
    // Well under ANSWER_MAX_CHARS, yet two facts.
    expect(report.checks.find((c) => c.id === "answer-too-long")?.severity).toBe("ok");
    expect(check(report, "multiple-facts").severity).toBe("warn");
  });

  it("long-list: a 9-item list warns; a 3-item list is ok", () => {
    const nine = evaluateCardQuality({
      kind: "qa",
      prompt: "Name the cranial nerves group",
      answer: "one, two, three, four, five, six, seven, eight, nine",
      hasSource: true,
    });
    expect(check(nine, "long-list").severity).toBe("warn");
    expect(parseListWarn(nine).items).toBeGreaterThan(LIST_ITEM_WARN_COUNT);

    const three = evaluateCardQuality({
      kind: "qa",
      prompt: "Name the primary colors",
      answer: "red, green, blue",
      hasSource: true,
    });
    expect(check(three, "long-list").severity).toBe("ok");
  });

  it("vague-pronoun: a bare 'this' with no named subject warns; a clear sentence is ok", () => {
    const vague = evaluateCardQuality({
      kind: "qa",
      prompt: "What does this do?",
      answer: "It runs.",
      hasSource: true,
    });
    expect(check(vague, "vague-pronoun").severity).toBe("warn");

    const clear = evaluateCardQuality({
      kind: "qa",
      prompt: "What does the mitochondrion produce?",
      answer: "Adenosine triphosphate from respiration.",
      hasSource: true,
    });
    expect(check(clear, "vague-pronoun").severity).toBe("ok");
  });

  it("vague-pronoun does NOT regress the existing leading-pronoun ambiguous-pronoun check", () => {
    // The T035 case still warns under its own id, unchanged.
    const report = evaluateCardQuality({
      kind: "qa",
      prompt: "What happens?",
      answer: "It increases this.",
      hasSource: true,
    });
    expect(check(report, "ambiguous-pronoun").severity).toBe("warn");
  });

  it("unsupported-claim: a sourceless claim-shaped answer warns; a sourced one is ok", () => {
    const sourceless = evaluateCardQuality({
      kind: "qa",
      prompt: "Effect of sleep deprivation?",
      answer: "Sleep deprivation causes a 40% drop in recall.",
      hasSource: false,
    });
    expect(check(sourceless, "unsupported-claim").severity).toBe("warn");

    const sourced = evaluateCardQuality({
      kind: "qa",
      prompt: "Effect of sleep deprivation?",
      answer: "Sleep deprivation causes a 40% drop in recall.",
      hasSource: true,
    });
    expect(check(sourced, "unsupported-claim").severity).toBe("ok");

    // A sourceless NON-claim (a plain definition) does not escalate.
    const definition = evaluateCardQuality({
      kind: "qa",
      prompt: "Define entropy",
      answer: "A measure of disorder.",
      hasSource: false,
    });
    expect(check(definition, "unsupported-claim").severity).toBe("ok");
  });

  it("outdated-source: time-sensitive language with no sourceDate warns; with a date it is ok", () => {
    const undated = evaluateCardQuality({
      kind: "qa",
      prompt: "What is the current LTS Node version?",
      answer: "Node 20.",
      hasSource: true,
    });
    expect(check(undated, "outdated-source").severity).toBe("warn");

    const dated = evaluateCardQuality({
      kind: "qa",
      prompt: "What is the current LTS Node version?",
      answer: "Node 20.",
      hasSource: true,
      sourceDate: "2024-05-01",
    });
    expect(check(dated, "outdated-source").severity).toBe("ok");
  });

  it("outdated-source: sourceIsStale warns even without time-sensitive language", () => {
    const stale = evaluateCardQuality({
      kind: "qa",
      prompt: "Define recursion",
      answer: "A function that calls itself.",
      hasSource: true,
      sourceIsStale: true,
    });
    expect(check(stale, "outdated-source").severity).toBe("warn");
  });

  it("outdated-source: a timeless claim adds NO outdated-source row", () => {
    const report = evaluateCardQuality({
      kind: "qa",
      prompt: "Define recursion",
      answer: "A function that calls itself.",
      hasSource: true,
    });
    expect(report.checks.find((c) => c.id === "outdated-source")).toBeUndefined();
  });

  it("oversized-cloze: a 12-word single deletion warns; a 3-word deletion is ok (independent of body length)", () => {
    const big = evaluateCardQuality({
      kind: "cloze",
      cloze:
        "The result is {{c1::a very long phrase that is basically a whole sentence to recall}}.",
      hasSource: true,
    });
    expect(check(big, "oversized-cloze").severity).toBe("warn");

    const ok = evaluateCardQuality({
      kind: "cloze",
      cloze: "Memory moves to the {{c1::neocortex region}}.",
      hasSource: true,
    });
    expect(check(ok, "oversized-cloze").severity).toBe("ok");
  });

  it("oversized-cloze is distinct from the whole-body answer-too-long check", () => {
    // A short whole body (under CLOZE_MAX_WORDS) but one over-long deletion.
    const cloze = `A is {{c1::${Array.from({ length: CLOZE_DELETION_MAX_WORDS + 4 }, (_, i) => `w${i}`).join(" ")}}}.`;
    const report = evaluateCardQuality({ kind: "cloze", cloze, hasSource: true });
    expect(report.checks.find((c) => c.id === "answer-too-long")?.severity).toBe("ok");
    expect(check(report, "oversized-cloze").severity).toBe("warn");
  });

  it("produces NO new block — only the hollow-card empty check ever blocks", () => {
    // A maximally-bad card (multi-fact, list, vague, claim, time-sensitive, oversized
    // cloze) still has exactly one possible blocker source: the empty/hollow check.
    const report = evaluateCardQuality({
      kind: "qa",
      prompt: "What is the current value of this, and that, and the other thing as of 2024?",
      answer: "It causes a, b, c, d, e, f, g. And it always proves the point.",
      hasSource: false,
    });
    expect(report.hasBlocker).toBe(false);
    expect(report.checks.filter((c) => c.severity === "block")).toHaveLength(0);
    // But it IS loud with warnings.
    expect(report.hasWarning).toBe(true);
  });

  it("a clean atomic card stays all-ok across the new checks too", () => {
    const report = evaluateCardQuality({
      kind: "qa",
      prompt: "How does Chollet define intelligence?",
      answer: "As skill-acquisition efficiency.",
      hasSource: true,
    });
    expect(report.hasWarning).toBe(false);
    expect(report.checks.every((c) => c.severity === "ok")).toBe(true);
  });
});

describe("detectInterference (T086 similar-answer)", () => {
  const candidate = {
    kind: "qa" as const,
    prompt: "What does deep sleep consolidate?",
    answer: "Deep sleep consolidates long-term memory.",
    hasSource: true,
  };

  it("warns when a sibling answer is near-identical", () => {
    const row = detectInterference(candidate, [
      { id: "sib_1", answer: "Deep sleep consolidates long term memory." },
    ]);
    expect(row).not.toBeNull();
    expect(row?.id).toBe("similar-answer");
    expect(row?.severity).toBe("warn");
  });

  it("returns null for a distinct sibling answer", () => {
    const row = detectInterference(candidate, [
      { id: "sib_1", answer: "The hippocampus encodes new episodic events." },
    ]);
    expect(row).toBeNull();
  });

  it("returns null for an empty candidate set (degrades gracefully)", () => {
    expect(detectInterference(candidate, [])).toBeNull();
  });

  it("compares a cloze sibling by its rendered body", () => {
    const row = detectInterference(candidate, [
      { id: "sib_1", cloze: "Deep sleep consolidates {{c1::long-term memory}}." },
    ]);
    expect(row).not.toBeNull();
  });

  it("answerSimilarity is 1 for identical normalized text and 0 for disjoint", () => {
    expect(answerSimilarity("Long-term memory", "long term memory")).toBe(1);
    expect(answerSimilarity("apple", "orange")).toBe(0);
  });
});

/** Read the item count out of the long-list warn message ("Long list (N items)…"). */
function parseListWarn(report: ReturnType<typeof evaluateCardQuality>): { items: number } {
  const row = report.checks.find((c) => c.id === "long-list");
  const match = row?.message.match(/\((\d+) items\)/);
  return { items: match ? Number.parseInt(match[1] ?? "0", 10) : 0 };
}
