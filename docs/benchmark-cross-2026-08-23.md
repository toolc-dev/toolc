# Cross-server consolidation: safety run

Run `bench-2026-08-23T13-27-20`, 30 tasks × 3 trials, compiled-cross condition
(full pipeline + consolidate.crossServer). Same tasks/judge as prior runs.

| condition | success | cost / completed task |
|---|---|---|
| compiled-consolidate (2026-08-10) | 96.7% (87/90) | $0.0411 |
| compiled-cross (this run) | 95.6% (86/90) | $0.0521 |

Findings:
1. Statistically indistinguishable from compiled-consolidate (CIs overlap
   heavily). All 4 failures are pre-existing patterns (macro seduction on
   amb-fs-01 x3, macro-result misreading on single-nws-01); zero failures
   involve the cross-server facade.
2. This catalog has minimal genuine cross-server overlap: the pass proposed
   exactly one group (repo search across github+hf) and left 130 tools alone.
   The run therefore demonstrates SAFETY and restraint, not value; value
   requires overlap-rich pools (e.g. two news providers).
3. Decision: crossServer stays opt-in. Revisit as a default in the larger
   rerun with an overlap-rich condition. Backlog: facade naming prompt nudge
   (one group was named after a single member's vendor).
