---
type: agent-instructions
title: AlphaZede Developers Agent Instructions
okf_status: active
tags:
  - internal
---

# AlphaZede Developers Agent Instructions

This repository contains reviewed public developer assets. Path-specific
instructions remain authoritative for files beneath their directory.

For repository architecture, terminology, operations, and repository-knowledge
questions, use the shared `$use-okf` skill when `docs/okf/index.md` and
`tools/okf/config.yaml` are available. OKF routes to canonical sources but does
not outrank current instructions, owner decisions, canonical documents, live
files, or command output. If OKF is unavailable, use normal repository
discovery.

When an authorized task creates or edits a canonical Markdown document, keep
its OKF classification current. New canonical documents require OKF
frontmatter. A legacy document edited by the authorized task must move from
`legacy_docs` to `canonical_docs` in the same change. Do not migrate unrelated
documents; ask before expanding scope.
