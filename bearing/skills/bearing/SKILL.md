---
name: bearing
description: Launch the local Bearing CLI and begin its planning-first repository journey when the user explicitly asks for Bearing.
type: agent-skill
title: Bearing
okf_status: active
tags:
  - developer
  - public
---

# Bearing

Use only for an explicit `/bearing` request. From the current repository, run
the installed `bearing` executable or the package-local `bearing/dist/cli.js`
with `start --no-open`; keep the local server alive and report its loopback URL.
Then follow Bearing's planning-first journey.

Do not use for ordinary planning, SessionStart, software installation, runtime
reimplementation, remote actions, or changes to Codex native collaboration.
