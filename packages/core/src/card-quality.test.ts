import { describe, expect, it } from "vitest";
import {
  ANSWER_MAX_CHARS,
  type CardQualityCheckId,
  type CardQualitySeverity,
  CLOZE_MAX_WORDS,
  CODE_MAX_LINES,
  evaluateCardQuality,
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
