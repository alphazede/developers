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

Use only for an explicit `/bearing` request. From the current repository, keep
PATH first and run the installed `bearing` executable with `start` when it is
available. Otherwise resolve `../../dist/cli.js` relative to this `SKILL.md`
directory, run that absolute path with Node and `start`, keep the local server
alive, and report its loopback URL. Never resolve the fallback from the current
or target repository. Bearing best-effort opens the browser automatically.
Then follow Bearing's planning-first journey.

Do not use for ordinary planning, SessionStart, software installation, runtime
reimplementation, filesystem-wide plugin discovery, target-repository changes,
remote actions, or changes to Codex native collaboration.
