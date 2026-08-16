import { describe, expect, test } from "bun:test";
import { PROMPTS, buildPromptMessages } from "./prompts";

describe("PROMPTS", () => {
  test("every prompt has a name, description, and argument descriptions", () => {
    expect(PROMPTS.length).toBeGreaterThan(0);
    for (const prompt of PROMPTS) {
      expect(prompt.name).toBeTruthy();
      expect(prompt.description).toBeTruthy();
      for (const argument of prompt.arguments) {
        expect(argument.name).toBeTruthy();
        expect(argument.description).toBeTruthy();
      }
    }
  });
});

describe("buildPromptMessages", () => {
  test("every listed prompt resolves with no arguments", () => {
    for (const prompt of PROMPTS) {
      const result = buildPromptMessages(prompt.name, {});
      expect(result.description).toBe(prompt.description);
      expect(result.messages.length).toBeGreaterThan(0);
      expect(result.messages[0].content.text.length).toBeGreaterThan(0);
    }
  });

  test("weekly_summary includes the start date when provided", () => {
    const result = buildPromptMessages("weekly_summary", {
      start_date: "2026-08-03"
    });
    expect(result.messages[0].content.text).toContain("2026-08-03");
    expect(result.messages[0].content.text).toContain('"custom"');
  });

  test("weekly_summary defaults to the weekly report without a start date", () => {
    const result = buildPromptMessages("weekly_summary", {});
    expect(result.messages[0].content.text).toContain('"weekly"');
  });

  test("sleep_analysis uses the provided day count", () => {
    const result = buildPromptMessages("sleep_analysis", { days: "30" });
    expect(result.messages[0].content.text).toContain("last 30 days");
  });

  test("sleep_analysis falls back to the default on invalid day counts", () => {
    for (const days of [undefined, "not-a-number", "-5", "0"]) {
      const result = buildPromptMessages("sleep_analysis", { days });
      expect(result.messages[0].content.text).toContain("last 14 days");
    }
  });

  test("workout_progress defaults to 90 days", () => {
    const result = buildPromptMessages("workout_progress", {});
    expect(result.messages[0].content.text).toContain("last 90 days");
  });

  test("unknown prompt names throw", () => {
    expect(() => buildPromptMessages("nope", {})).toThrow("Unknown prompt: nope");
  });
});
