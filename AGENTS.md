# JigeRPG implementation

- Preserve the `baseline-original` tag. Work on local branches; push only when the user explicitly requests publication to the named repository.
- Commit each independently verified change. Do not commit runtime state, credentials, old save backups, node_modules or generated builds.
- Use the latest verified stable dependencies. The project-private Node runtime lives in ignored `.tools/`; do not replace system Node.
- The app lives at the repository root: `src/{shared,engine,content,server,client}`, `scripts/`, `tests/`, and `reference/`. The retired `origin/` directory must not be restored into published snapshots. Keep the shared model and API contract consistent.
- Server is authoritative: validated commands, cryptographic dice, version checks, transactional persistence, idempotency and visibility filtering. Never accept client damage totals as authority.
- Rules baseline is SRD 5.2.1 (2024). Never silently apply legacy formulas or label unsupported deterministic rules as automated.
- Legacy import is copy-only, transactional and idempotent. Preserve original bytes and all unconverted fields. Never modify old browser storage keys.
- Tests must exercise actual behavior and failure modes. Use deterministic injected dice in rules tests.
- Parallel work uses separate worktrees. Commit only files owned by your task; report commits and checks for sequential integration.
