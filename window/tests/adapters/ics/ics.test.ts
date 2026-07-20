import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { IcsBoundaryError, exportApproved, parsePreview } from "../../../src/adapters/ics";

const input = { consentRevision: 1, fetchedAt: "2026-07-23T15:00:00Z" } as const;
const calendar = (...lines: string[]) => new TextEncoder().encode(`${lines.join("\r\n")}\r\n`);
const event = (extra: readonly string[] = []) => calendar(
  "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:event-a", "DTSTART:20260723T180000Z",
  "DTEND:20260723T183000Z", "SUMMARY:Planning\\, review", ...extra, "END:VEVENT", "END:VCALENDAR",
);

describe("ICS adapter", () => {
  it("parses stable UTC and bounded zoned recurrence previews", async () => {
    const bytes = await readFile(new URL("../../../fixtures/connectors/ics/valid.ics", import.meta.url));
    const one = await parsePreview(bytes, input), two = await parsePreview(bytes, input);
    expect(two).toEqual(one);
    expect(one).toMatchObject({ schemaVersion: 1, previewOnly: true, previewHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(one.events.map((item) => [item.uid, item.commitment.startAt, item.commitment.title])).toEqual([
      ["fixture-weekly", "2026-07-23T14:00:00Z", "Weekly focus"],
      ["fixture-one", "2026-07-23T18:00:00Z", "Planning, review"],
      ["fixture-weekly", "2026-07-30T14:00:00Z", "Weekly focus"],
    ]);
    expect(one.events.every((item) => item.commitment.provenance.source === "ics" && item.commitment.provenance.freshness.state === "fixture")).toBe(true);
    expect(Object.isFrozen(one.events[0]!.commitment.provenance)).toBe(true);
  });

  it("applies a matching recurrence exception and rejects unsupported recurrence", async () => {
    const preview = await parsePreview(calendar(
      "BEGIN:VCALENDAR", "VERSION:2.0",
      "BEGIN:VEVENT", "UID:series-a", "DTSTART:20260723T180000Z", "DTEND:20260723T183000Z", "SUMMARY:Weekly", "RRULE:FREQ=WEEKLY;COUNT=2", "END:VEVENT",
      "BEGIN:VEVENT", "UID:series-a", "RECURRENCE-ID:20260730T180000Z", "DTSTART:20260730T190000Z", "DTEND:20260730T193000Z", "SUMMARY:Moved", "END:VEVENT",
      "END:VCALENDAR",
    ), input);
    expect(preview.events.map((item) => [item.commitment.startAt, item.commitment.title])).toEqual([
      ["2026-07-23T18:00:00Z", "Weekly"], ["2026-07-30T19:00:00Z", "Moved"],
    ]);
    for (const bytes of [event(["RRULE:FREQ=WEEKLY"]), event(["RRULE:FREQ=MONTHLY;COUNT=2"]), event(["RRULE:FREQ=WEEKLY;COUNT=2;BYDAY=TH"]), event(["EXRULE:FREQ=DAILY"])]) {
      await expect(parsePreview(bytes, input)).rejects.toBeInstanceOf(IcsBoundaryError);
    }
  });

  it("rejects floating, ambiguous, nonexistent, and unknown-zone local time", async () => {
    const zoned = (line: string) => calendar("BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:zone", line, "DTEND;TZID=America/Chicago:20261101T023000", "SUMMARY:Zone", "END:VEVENT", "END:VCALENDAR");
    await expect(parsePreview(zoned("DTSTART:20261101T010000"), input)).rejects.toMatchObject({ code: "UNSUPPORTED_TIME" });
    await expect(parsePreview(zoned("DTSTART;TZID=America/Chicago:20261101T013000"), input)).rejects.toMatchObject({ code: "AMBIGUOUS_WALL_TIME" });
    await expect(parsePreview(calendar("BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:gap", "DTSTART;TZID=America/Chicago:20260308T023000", "DTEND;TZID=America/Chicago:20260308T033000", "SUMMARY:Gap", "END:VEVENT", "END:VCALENDAR"), input)).rejects.toMatchObject({ code: "NONEXISTENT_WALL_TIME" });
    await expect(parsePreview(calendar("BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:bad-zone", "DTSTART;TZID=Mars/Base:20260723T090000", "DTEND;TZID=Mars/Base:20260723T093000", "SUMMARY:Zone", "END:VEVENT", "END:VCALENDAR"), input)).rejects.toMatchObject({ code: "UNKNOWN_TIME_ZONE" });
  });

  it("rejects duplicate, hidden, folded-control, malformed UTF-8, and oversized data", async () => {
    await expect(parsePreview(event(["UID:event-b"]), input)).rejects.toMatchObject({ code: "DUPLICATE_PROPERTY" });
    await expect(parsePreview(new TextEncoder().encode(`${new TextDecoder().decode(event())}BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n`), input)).rejects.toMatchObject({ code: "MALFORMED_CALENDAR" });
    await expect(parsePreview(calendar(" BEGIN:VCALENDAR", "VERSION:2.0", "END:VCALENDAR"), input)).rejects.toMatchObject({ code: "MALFORMED_CALENDAR" });
    await expect(parsePreview(Uint8Array.from([0xff, 0xfe]), input)).rejects.toMatchObject({ code: "INVALID_UTF8" });
    await expect(parsePreview(new Uint8Array(5 * 1024 * 1024 + 1), input)).rejects.toMatchObject({ code: "OVERSIZED_SOURCE" });
  });

  it("exports only explicit local approvals as reproducible redacted CRLF bytes and round-trips", async () => {
    const items = [
      { id: "local-b", source: "local" as const, approved: true as const, title: "Review; notes", startAt: "2026-07-23T19:00:00Z", endAt: "2026-07-23T19:30:00Z" },
      { id: "local-a", source: "local" as const, approved: true as const, title: "Focus, work", startAt: "2026-07-23T18:00:00Z", endAt: "2026-07-23T18:30:00Z" },
    ];
    const first = exportApproved(items), second = exportApproved([...items].reverse());
    expect(second).toBe(first);
    expect(first.endsWith("\r\n")).toBe(true);
    expect(first.replace(/\r\n/g, "")).not.toContain("\n");
    expect(first).toContain("SUMMARY:Focus\\, work");
    expect(first).not.toMatch(/participant|provenance|token|sourceEntity/i);
    expect((await parsePreview(new TextEncoder().encode(first), input)).events.map((item) => item.commitment.title)).toEqual(["Focus, work", "Review; notes"]);
    expect(() => exportApproved([{ ...items[0]!, source: "ics" as "local" }])).toThrowError("INVALID_EXPORT");
  });

  it("records a 100-run parser receipt", async () => {
    const bytes = event(), samples: number[] = [];
    for (let index = 0; index < 100; index += 1) { const started = performance.now(); await parsePreview(bytes, input); samples.push(performance.now() - started); }
    samples.sort((a, b) => a - b);
    const receipt = { iterations: 100, p50: samples[49]!, p95: samples[94]! };
    console.info("ics-parser-benchmark", JSON.stringify(receipt));
    expect(receipt.p95).toBeLessThan(100);
  });
});
