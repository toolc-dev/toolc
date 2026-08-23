# Benchmark v2: 60 tasks, two models, overlap-rich pool

Runs `bench-2026-08-23T14-57-06` (claude-sonnet-4-6) and
`bench-2026-08-23T18-03-03` (claude-haiku-4-5). 60 tasks x 3 trials x 5
conditions per model (1,800 trials). Pool: 137 tools across 6 servers,
including two REST APIs composed via the openapi frontend (Open-Meteo,
HN Algolia) that create genuine cross-server overlap in weather and
article search. New overlap-selection category (10 tasks) probes
cross-source arbitration, including sources that cannot answer.

## Headline

| condition | sonnet success | sonnet $/task | haiku success | haiku $/task |
|---|---|---|---|---|
| raw (137 tools) | 96.7% | $0.260 | 90.6% | $0.090 |
| compiled | 96.1% | $0.064 | 77.2% | $0.027 |
| compiled-consolidate | 96.1% | $0.052 | 81.7% | $0.022 |
| consolidate-no-selection | 94.4% | $0.151 | 80.6% | $0.107 |
| compiled-cross | 96.1% | $0.054 | 81.7% | $0.026 |

## Findings

1. **Frontier models: compilation is ~free accuracy at 5x lower cost.**
   Sonnet's compiled conditions are statistically indistinguishable from raw
   (CIs overlap fully) at one-fifth the cost. compiled-consolidate is the
   best profile on both axes.
2. **Compilation FIXES cross-source arbitration for capable models.** On
   overlap-selection tasks, raw scored 90.0% with sonnet while every
   compiled condition scored 100%: pool-aware disambiguation rewrites beat
   the naive federation exactly where multiple vendors overlap.
3. **The benefit is capability-gated.** Haiku reads the raw catalog well
   (90.6%) but pays ~9 points for compiled indirection (wrong-tool rate 5.3%
   raw vs ~24% compiled), and its overlap result inverts. Guidance: compiled
   surfaces for frontier agents; direct/mirror surfaces for small models.
4. **The pilot's 100% no-selection result was small-n flattery.** At 60
   tasks it drops to 94.4% (sonnet), behind compiled-consolidate; "maximum
   accuracy" framing for the no-selection profile is retired.
5. **Cross-server consolidation: safe, tied-best, still not differentiated.**
   Identical accuracy to compiled-consolidate on both models; its one merged
   capability (repo search) and the disambiguation rewrites appear to carry
   the same load. Remains opt-in.

Judge: claude-opus-4-8 (judge-v2, answers only). Same caveats as v1 on
judge circularity, mitigated by rubric grading and immutable-fact tasks.
