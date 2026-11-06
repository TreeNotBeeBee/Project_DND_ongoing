# JigeRPG implementation

- Preserve the `baseline-original` tag. Work on local branches; push only when the user explicitly requests publication to the named repository.
- Commit each independently verified change. Do not commit runtime state, credentials, old save backups, node_modules or generated builds.
- Use the latest verified stable dependencies. The project-private Node runtime lives in ignored `.tools/`; do not replace system Node.
- The app lives at the repository root: `src/{shared,engine,content,server,client}`, `scripts/`, `tests/`, and `reference/`. The retired `origin/` directory must not be restored into published snapshots. Keep the shared model and API contract consistent.
- Server enforces authentication, ownership, version checks, transactional persistence, idempotency and visibility filtering. Human-GM and free-world commands retain their rule engines. In AI display protocol v2, AI-provided game values are authoritative: validate JSON format and technical limits only, never recalculate, clamp, or reject values for game-rule reasons. Player intents never directly change game values.
- Standard characters use SRD 5.2.1 (2024). Free characters use explicit, persistent manual values and configured actions; never force standard creation requirements on them. Never silently apply legacy formulas or label unsupported deterministic rules as automated.
- World modes are fixed on creation: human GM, manual AI JSON, or cooperative creation. The persistent world owner is independent of narrative authority. Cooperative governance is democratic (optional owner approval/veto) or dictatorship with revocable scoped delegation. Enforce capabilities and private projections on the server.
- Legacy import is copy-only, transactional and idempotent. Preserve original bytes and all unconverted fields. Never modify old browser storage keys.
- Tests must exercise actual behavior and failure modes. Use deterministic injected dice in rules tests.
- Parallel work uses separate worktrees. Commit only files owned by your task; report commits and checks for sequential integration.
