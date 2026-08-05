import { defineMacro } from "@toolc/core";
import { z } from "zod";

/**
 * Provenance: the find-company → find-events → search-transcripts chain is the
 * canonical multi-hop pattern on the Aiera server (spec §6.4's own example);
 * observed in real usage as the dominant path to "what did management say
 * about X".
 *
 * NOTE: argument shapes follow the spec example; verify against the live
 * Aiera catalog before the benchmark freeze (M4) — this macro is skipped at
 * compile time with a warning unless the aiera downstream is configured.
 */
export const getLatestEarningsDiscussion = defineMacro({
  name: "get_latest_earnings_discussion",
  description:
    "Given a stock ticker and a topic, return what management said about that topic on the company's most recent earnings call. " +
    "Single call; replaces the find_events → search_transcripts chain.",
  inputSchema: z.object({
    ticker: z.string().describe("Bloomberg-style ticker, e.g. INTC"),
    topic: z.string().describe("Topic to search for, e.g. 'foundry customer commitments'"),
  }),
  uses: ["aiera:find_events", "aiera:search_transcripts"],
  steps: async (input, call) => {
    const events = await call("aiera:find_events", {
      bloomberg_ticker: `${input.ticker.toUpperCase()}:US`,
      event_type: "earnings",
      size: 5,
    });
    if (events.isError) return events;

    const eventId = pickLatestEventId(events.structured ?? events.text);
    if (eventId === null) {
      return {
        text: `no recent earnings events found for ${input.ticker}`,
        isError: true,
      };
    }
    return call("aiera:search_transcripts", {
      event_ids: [eventId],
      query_text: input.topic,
    });
  },
});

/** Extract the most recent event id from a structured or JSON-ish events payload. */
function pickLatestEventId(payload: unknown): number | string | null {
  let data = payload;
  if (typeof data === "string") {
    const text = data;
    try {
      data = JSON.parse(text);
    } catch {
      const match = /"event_id"\s*:\s*(\d+)/.exec(text);
      return match ? Number(match[1]) : null;
    }
  }
  const events = Array.isArray(data)
    ? data
    : ((data as { events?: unknown[]; results?: unknown[]; data?: unknown[] })?.events ??
      (data as { results?: unknown[] })?.results ??
      (data as { data?: unknown[] })?.data);
  if (!Array.isArray(events) || events.length === 0) return null;
  const first = events[0] as { event_id?: number | string; id?: number | string };
  return first.event_id ?? first.id ?? null;
}
