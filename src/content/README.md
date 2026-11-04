# Local 2024 SRD catalog

The raw catalog is pinned to the 5e-bits commit in `raw/manifest.json`. Only the upstream `src/2024/en` tree is imported; no 2014 or non-SRD expansion tree is merged. The database adapter is community maintained, not a Wizards rules engine. Its structured fields are checked by adapters and tests; prose is retained for review. Runtime is entirely local.

This work includes material from the System Reference Document 5.2.1 (“SRD 5.2.1”) by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.

The upstream database code license is retained in `raw/UPSTREAM-LICENSE.md`. Source file hashes permit reproducible review. Run `node scripts/sync-content.mjs PATH_TO_PINNED_2024_EN` to regenerate; inspect upstream changes and run the content tests before updating the pin.

`coverage` is a machine-readable per-entry matrix. `automatic` means the adapter can execute its supported structured behavior; `choice` means a player/GM selects content; `adjudication` is inherently narrative; `unsupported` blocks unimplemented deterministic behavior. A catalog entry is not proof of complete automation. In particular, listing all classes and their level tables does not mean every class feature is implemented. `coverage.complete` stays false until that audited work is done.
