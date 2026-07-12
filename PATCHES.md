# Hyprlane Wave patch stack

Base: Wave `v0.14.5` at
`97e560027f494d20fed347b2d6b72b6bcb3e50e0`.

The working branch is intentionally uncommitted until Hyprlane's reviewed
Phase 6 checkpoints pass. Keep eventual commits separated in this order:

1. `host:` fork-local ESM host and hosted-surface seams
2. `security:` transport, preload, environment, and origin hardening
3. `lifecycle:` PTY cap, TTL, process-group teardown, and replay bounds
4. `brand:` assets, names, licenses, and outbound endpoint removal
5. `build:` reproducible artifacts, manifests, nested signing, and release

Do not import Wave's process-global `emain/emain.ts` from the host library.
Do not add Hyprlane product state to WOS or translate WOS into Hyprlane models.
