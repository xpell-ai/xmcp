# Changelog

## [2.0.8] — 2026-11-13 (unreleased candidate)

- Coordinate the existing Streamable HTTP MCP adapter, curated tool registry and XAuth integration with the 2.0.8 runtime.
- Align the default MCP server package-version advertisement with 2.0.8.
- Include the declared MIT license and release notes; remove the nonexistent docs entry from the publication allowlist.

Compatibility: internal workspace specifications are retained. No public API redesign, PostgreSQL backend, persistence migration or automatic SQLite activation is introduced by this preparation.

Validation: package builds and available tests are recorded in the coordinated Gate 2 report. Gate 3 must verify the exact packed artifacts and clean-consumer compatibility before publication. These entries describe verified checked-out capabilities and release-preparation deltas; they do not claim that every capability is new relative to the last npm artifact.

