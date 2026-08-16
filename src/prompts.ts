// Prompt templates exposed over MCP prompts/list and prompts/get. Each prompt
// compiles the data-model rules from docs/querying.md into instructions a
// client model can follow with the health_schema/health_query/health_report
// tools.

export interface PromptDefinition {
  name: string;
  description: string;
  arguments: Array<{
    name: string;
    description: string;
    required: boolean;
  }>;
}

export const PROMPTS: PromptDefinition[] = [
  {
    name: "weekly_summary",
    description:
      "Summarize the most recent week of health data: activity, heart rate, sleep, and workouts",
    arguments: [
      {
        name: "start_date",
        description:
          "Week start date (YYYY-MM-DD). Defaults to the most recent full week.",
        required: false
      }
    ]
  },
  {
    name: "sleep_analysis",
    description:
      "Analyze sleep duration, stages, and consistency over a recent period",
    arguments: [
      {
        name: "days",
        description: "Number of days to analyze (default 14)",
        required: false
      }
    ]
  },
  {
    name: "workout_progress",
    description:
      "Review workout frequency, duration, and trends over a recent period",
    arguments: [
      {
        name: "days",
        description: "Number of days to analyze (default 90)",
        required: false
      }
    ]
  }
];

const SHARED_RULES = `Ground rules for querying this data:
- Call health_schema first to see which tables this export actually contains.
- Only SELECT queries are accepted by health_query.
- Check the unit column before combining values; units vary by source device.
- Multiple devices can record overlapping rows, so per-source breakdowns are safer than naive sums.
- Category tables (e.g. sleep stages) keep their label in valueText; their numeric value is NULL.
- Derive durations from startDate and endDate, e.g. DATE_DIFF('second', startDate, endDate).`;

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function buildPromptMessages(
  name: string,
  args: Record<string, string | undefined>
): { description: string; messages: Array<{ role: "user"; content: { type: "text"; text: string } }> } {
  const definition = PROMPTS.find((prompt) => prompt.name === name);
  if (!definition) {
    throw new Error(`Unknown prompt: ${name}`);
  }

  let text: string;
  switch (name) {
    case "weekly_summary": {
      const start = args.start_date;
      text = `Produce a weekly health summary${start ? ` for the week starting ${start}` : " for the most recent full week"}.

Start with the health_report tool (report_type: ${start ? `"custom" with start_date/end_date` : `"weekly"`}), then use health_query to drill into anything notable.

${SHARED_RULES}

Structure the summary as: overall activity (steps, distance, energy), heart rate ranges, sleep totals, and workouts. Close with 2-3 concrete observations or trends worth watching.`;
      break;
    }
    case "sleep_analysis": {
      const days = positiveInt(args.days, 14);
      text = `Analyze my sleep over the last ${days} days using the sleep analysis table.

${SHARED_RULES}

Sleep specifics:
- Stage labels live in valueText; sum DATE_DIFF('second', startDate, endDate) per stage per night.
- Total asleep time should match LOWER(valueText) LIKE '%asleep%' to exclude awake and in-bed rows.

Report nightly totals, average sleep duration, stage breakdown, bedtime/wake-time consistency, and any nights that stand out.`;
      break;
    }
    case "workout_progress": {
      const days = positiveInt(args.days, 90);
      text = `Review my workout progress over the last ${days} days.

Use health_schema's commonPatterns.workouts to find the workout tables in this export (they may be one combined table or one per activity type).

${SHARED_RULES}

Report workouts per week, duration trends (from startDate/endDate, not exported duration fields), the mix of activity types, and whether volume is trending up or down.`;
      break;
    }
    default:
      throw new Error(`Unknown prompt: ${name}`);
  }

  return {
    description: definition.description,
    messages: [{ role: "user", content: { type: "text", text } }]
  };
}
