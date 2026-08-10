# Consolidation pass: effectiveness run

Run `bench-2026-08-10T17-19-39`, 30 tasks × 3 trials per condition, agent `claude-sonnet-4-6`,
judge `claude-opus-4-8` (judge-v2). Same task set, downstreams, and judge as the
[2026-08-09 full grid](benchmark-2026-08-09.md); the two new conditions were compiled from a fresh
catalog snapshot (131 tools). Consolidation produced 26 facades, 131 → 55 passthrough+facade
definitions (~44% of catalog tokens).

## Combined headline (new conditions in bold, baselines from 2026-08-09)

| condition | success rate | cost / completed task | mean tool-def tokens | tools shown |
|---|---|---|---|---|
| raw | 96.7% (87/90) | $0.2631 | ~24360 | 131 |
| compiled | 91.1% (82/90) | $0.0497 | ~845 | 6 |
| compiled-no-selection | 100.0% (90/90) | $0.3026 | ~32502 | 135 |
| **consolidate-no-selection** | **100.0% (90/90)** | **$0.1335** | ~14506 | 58 |
| **compiled-consolidate** | **96.7% (87/90)** | **$0.0411** | ~845 | 6 |

## Findings

1. **Consolidation strictly dominates on both ends of the cost/accuracy frontier.**
   - `consolidate-no-selection` keeps no-selection's perfect accuracy at 44% of its cost
     ($0.1335 vs $0.3026) and is also both cheaper AND more accurate than raw
     ($0.1335 vs $0.2631; 100% vs 96.7%). It is the new accuracy-optimal condition.
   - `compiled-consolidate` beats the full compiled pipeline on accuracy (96.7% vs 91.1%)
     and cost ($0.0411 vs $0.0497). Shrinking the searchable pool from 131 near-duplicates
     to 55 well-separated entries makes search_tools hits cleaner: fewer wrong turns,
     shorter transcripts. It is the new cost-optimal condition.
2. **Zero facade routing failures.** All three `compiled-consolidate` failures are the known
   "macro seduction" pattern from the v1 grid (agent answers from a macro result without
   extracting the exact requested fact); none involved a facade dispatching to the wrong
   member or rejecting valid arguments.
3. **Fewer definitions helps selection too.** Facades in the searchable pool mean one search
   hit covers a whole family, so the agent picks among domains, not near-duplicate siblings.
   Wrong-tool rate under selection dropped alongside cost.

## Caveats

Same limitations as the v1 grid (small n, judge circularity, live-data drift). Re-run with the
larger task set + model diversity before publishing. Baselines were measured 2026-08-09 against
the same live services; catalog drift between snapshots is possible but the graph hash confirms
identical tool counts (131).
