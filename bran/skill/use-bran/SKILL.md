---
name: use-bran
description: Use for repository knowledge and evidence discovery, focused source selection, OKF/BRAN metadata, context packets, validation, provenance, metrics, or maintainer proposals. Trigger when repository-wide context must be selected or verified before acting. Do not trigger for unrelated general questions, already-bounded single-file edits needing no repository discovery, or direct mutation or deploy authorization.
---

# Use BRAN

Copy this skill folder into the consuming agent host's skill directory. Do not require global model or provider settings.

Verify the local installation before delegating:

```sh
bran doctor --agent
bran agents list
```

Read the complete doctor envelope. Do not treat `requested` as `effective`, and
do not infer a connected runtime, SQZ capability, reasoning level, or token-limit
enforcement when its state is `unavailable`. `local_setup_ready` does not make
`connected_execution_ready`; a validation exit is expected until runtime and
host attestation are effective.

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

## Optional delegated task

Keep repository retrieval separate from optional synthesis. Select a registered
profile from `bran agents list`, then request an exact supported reasoning value
and the smallest read-only tool set:

```sh
bran -p --agent <profile> --reasoning medium --tools read,search --no-session "<task>"
```

Use `--no-session` when conversation retention is not required. To prove a clean
return to deterministic offline behavior, add `--offline`; an incomplete receipt
with explicit offline authority is expected and must not be presented as a
generated answer. Never pass credentials on the command line. If effective
execution or token use cannot be attested, report it as unavailable.

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
