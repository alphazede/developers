---
name: use-bran
description: Use for repository knowledge and evidence discovery, focused source selection, OKF/BRAN metadata, context packets, validation, provenance, metrics, or maintainer proposals. Trigger when repository-wide context must be selected or verified before acting. Do not trigger for unrelated general questions, already-bounded single-file edits needing no repository discovery, or direct mutation or deploy authorization.
---

# Use BRAN

Copy this skill folder into the consuming agent host's skill directory. Do not require global model or provider settings.

## Workflow

1. Run the packet command before broad repository search when a focused context packet can answer the request:

   ```sh
   bran packet <repo-root> "<request>"
   ```

   The current `packet` command does not invoke SQZ. Do not claim compression or savings unless the returned receipt proves them.

2. Use focused discovery when a packet is not appropriate or needs follow-up:

   ```sh
   bran query <repo-root> "<request>"
   ```

3. Validate repository metadata or a selected profile before relying on it:

   ```sh
   bran check <repo-root> <profile>
   ```

Treat `query`, `packet`, and `check` as read-only. Consume the complete returned envelope: act on `status`, investigate and report `failures`, retain and report `provenance`, and report `metrics`. Report actual model tokens as unavailable when the response says unavailable. Label any `bytes-divided-by-four-ceiling` count as an estimate, not actual token use.

## Maintainer changes

Produce a zero-mutation proposal first:

```sh
bran maintain propose <repo-root> <target> <replacement>
```

Use its returned digest exactly. Apply only with explicit authority for that exact change; `apply` performs revalidation:

```sh
bran maintain apply <repo-root> <target> <replacement> <digest> <authority>
```

Revalidate independently when requested or after any follow-up change:

```sh
bran maintain revalidate <repo-root>
```

Use and report every returned status, failure, provenance entry, and metric. Never infer success from command intent alone.

## Fallback

Treat missing or failed BRAN evidence as a fallback signal. Use bounded `git`, `rg`, or language-tool evidence, and report that fallback and its limits. Never fabricate BRAN results, provenance, metrics, compression, savings, or token counts.
