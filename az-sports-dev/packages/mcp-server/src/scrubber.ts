const PATTERNS: Array<[RegExp, string]> = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>"],
  [
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/g,
    "<uuid>",
  ],
  [
    /\b(Player|player) [A-Z][a-zA-Z'.-]+(?: [A-Z][a-zA-Z'.-]+)*\b/g,
    "$1 <name>",
  ],
  // Keep free-form player-name scrubbing conservative.
  [/\b(for) [A-Z][a-zA-Z'.-]+(?: [A-Z][a-zA-Z'.-]+)+\b/g, "$1 <name>"],
  [/[A-Z]{2,6}_\d{4}-\d{2}-\d{2}_[A-Z]{3}_[A-Z]{3}/g, "<game_id>"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<ip>"],
];

export function scrub(msg: string): string {
  let out = msg;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
