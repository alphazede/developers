import { Temporal } from "@js-temporal/polyfill";

import type { TodayProjectionV1, TimelineEntryV1 } from "../../ui/projections";

export type CalendarCategory = "focus" | "meeting" | "task" | "recovery" | "personal" | "tentative";
export type CalendarAvailability = "busy" | "free" | "tentative";

export const calendarCategories: ReadonlyArray<Readonly<{ id: CalendarCategory; label: string; symbol: string }>> = [
  { id: "focus", label: "Focus / deep work", symbol: "▣" },
  { id: "meeting", label: "Meeting", symbol: "◆" },
  { id: "task", label: "Task / deadline", symbol: "●" },
  { id: "recovery", label: "Recovery / buffer", symbol: "≈" },
  { id: "personal", label: "Personal / health", symbol: "○" },
  { id: "tentative", label: "Tentative / unknown", symbol: "◇" },
];

const categoryById = Object.fromEntries(calendarCategories.map((item) => [item.id, item])) as Record<CalendarCategory, (typeof calendarCategories)[number]>;

export type CalendarClassificationInput = Readonly<{ title: string; type?: string; source?: string }>;
export type CalendarClassification = Readonly<{ category: CalendarCategory; reason: string }>;

export const autoColorEvent = ({ title, type = "", source = "" }: CalendarClassificationInput): CalendarClassification => {
  const text = `${title} ${type} ${source}`.toLowerCase();
  if (type === "recovery" || /\b(recovery|buffer|reset|break)\b/.test(text)) {
    return { category: "recovery", reason: "Recovery and buffer language maps to the recovery category." };
  }
  if (/\b(workout|health|doctor|dentist|partner|personal|movement|training)\b/.test(text)) {
    return { category: "personal", reason: "Personal or health language maps to the personal category." };
  }
  if (type === "protected" || /\b(focus|deep[- ]?work|quiet|writing|draft)\b/.test(text)) {
    return { category: "focus", reason: "Protected or deep-work language maps to the focus category." };
  }
  if (/\b(hold|maybe|tentative|unknown)\b/.test(text) || type === "proposal") {
    return { category: "tentative", reason: "A proposal or hold remains tentative until explicitly approved." };
  }
  if (type === "task" || type === "deadline" || /\b(deadline|task|follow-up|milestone|work item)\b/.test(text) || /github|linear|gmail/.test(source.toLowerCase())) {
    return { category: "task", reason: "Task, deadline, or imported-work provenance maps to the task category." };
  }
  if (type === "hard" || /\b(meeting|review|sync|call|interview|lesson|check-in)\b/.test(text)) {
    return { category: "meeting", reason: "Meeting and collaboration language maps to the meeting category." };
  }
  return { category: "tentative", reason: "No stable rule matched, so the event stays visibly tentative." };
};

export type CalendarEvent = Readonly<{
  id: string;
  date: string;
  title: string;
  startMinutes: number;
  endMinutes: number;
  startLabel: string;
  endLabel: string;
  startAt: string;
  endAt: string;
  category: CalendarCategory;
  categoryLabel: string;
  categorySymbol: string;
  colorReason: string;
  availability: CalendarAvailability;
  sourceLabel: string;
  statusLabel: string;
  mutabilityLabel: string;
  detail: string;
  priority: "protected" | "high" | "standard" | "tentative";
  protected: boolean;
  synthetic: boolean;
}>;

export type CalendarDay = Readonly<{
  date: string;
  label: string;
  dayNumber: number;
  inMonth: boolean;
  events: readonly CalendarEvent[];
}>;

export type CalendarMonth = Readonly<{
  title: string;
  selectedFixtureDate: string;
  days: readonly CalendarDay[];
}>;

const formatMinute = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const zoned = (instant: string, timeZone: string) => Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone);
const instantParts = (instant: string, timeZone: string) => {
  const value = zoned(instant, timeZone);
  return { date: value.toPlainDate().toString(), minute: value.hour * 60 + value.minute, label: formatMinute(value.hour * 60 + value.minute) };
};
export const formatCalendarDate = (date: string, options: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric" }) => new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));

const eventDetail = (entry: TimelineEntryV1, category: CalendarCategory) => {
  if (category === "focus") return "Protected focus time blocks conflicting meetings in this local scheduling view.";
  if (category === "meeting") return "Busy meeting time participates in conflict checks; demanding meetings keep a recovery buffer visible.";
  if (category === "recovery") return "A before/after buffer keeps adjacent meeting slots unavailable without extending the meeting itself.";
  if (category === "personal") return "Protected personal time remains unavailable to new meetings.";
  if (category === "tentative") return "This proposal is a local preview. It does not approve a placement or change its source.";
  return entry.mutabilityLabel.includes("read-only")
    ? "Imported task evidence stays read-only; any calendar placement remains a local preview."
    : "Task placement is shown from the deterministic local projection.";
};

const timelineEvent = (entry: TimelineEntryV1, timeZone: string): CalendarEvent => {
  const start = instantParts(entry.startAt, timeZone), end = instantParts(entry.endAt, timeZone);
  const classification = autoColorEvent(entry);
  const isProtected = entry.type === "protected" || entry.status === "approved";
  return {
    id: entry.id,
    date: start.date,
    title: entry.title,
    startMinutes: start.minute,
    endMinutes: end.date === start.date ? end.minute : 24 * 60,
    startLabel: start.label,
    endLabel: end.label,
    startAt: entry.startAt,
    endAt: entry.endAt,
    category: classification.category,
    categoryLabel: categoryById[classification.category].label,
    categorySymbol: categoryById[classification.category].symbol,
    colorReason: classification.reason,
    availability: entry.type === "proposal" ? "tentative" : "busy",
    sourceLabel: entry.sourceLabel,
    statusLabel: entry.statusLabel,
    mutabilityLabel: entry.mutabilityLabel,
    detail: eventDetail(entry, classification.category),
    priority: entry.type === "proposal" ? "tentative" : isProtected ? "protected" : entry.type === "task" ? "high" : "standard",
    protected: isProtected,
    synthetic: false,
  };
};

const deadlineEvents = (projection: TodayProjectionV1): CalendarEvent[] => projection.backlog.flatMap((task) => {
  if (!task.deadlineAt) return [];
  const due = instantParts(task.deadlineAt, projection.timeZone);
  const startMinutes = Math.max(0, due.minute - 15);
  const classification = autoColorEvent({ title: task.title, type: "deadline", source: task.source });
  return [{
    id: `deadline-${task.id}`,
    date: due.date,
    title: `${task.title} due`,
    startMinutes,
    endMinutes: due.minute,
    startLabel: `Due ${due.label}`,
    endLabel: due.label,
    startAt: task.deadlineAt,
    endAt: task.deadlineAt,
    category: classification.category,
    categoryLabel: categoryById[classification.category].label,
    categorySymbol: categoryById[classification.category].symbol,
    colorReason: classification.reason,
    availability: "busy" as const,
    sourceLabel: task.sourceLabel,
    statusLabel: "Deadline",
    mutabilityLabel: task.mutabilityLabel,
    detail: task.mutable ? "A local task deadline." : "Imported source deadline — read-only; calendar treatment is local only.",
    priority: "high" as const,
    protected: false,
    synthetic: false,
  }];
});

const focusPreview = (projection: TodayProjectionV1): CalendarEvent[] => {
  const task = projection.backlog.find((item) => item.mutable && /focus|deep[- ]?work|draft/i.test(item.title));
  const point = [...projection.capacityPoints]
    .filter((item) => item.capacity !== null)
    .sort((left, right) => (right.capacity ?? 0) - (left.capacity ?? 0) || left.startAt.localeCompare(right.startAt))[0];
  if (!task || !point) return [];
  const start = instantParts(point.startAt, projection.timeZone);
  const duration = task.durationMinutes ?? 30;
  const classification = autoColorEvent({ title: task.title, type: "task", source: task.source });
  return [{
    id: `focus-preview-${task.id}`,
    date: projection.date,
    title: task.title,
    startMinutes: start.minute,
    endMinutes: Math.min(24 * 60, start.minute + duration),
    startLabel: start.label,
    endLabel: formatMinute(Math.min(24 * 60 - 1, start.minute + duration)),
    startAt: point.startAt,
    endAt: point.startAt,
    category: classification.category,
    categoryLabel: categoryById[classification.category].label,
    categorySymbol: categoryById[classification.category].symbol,
    colorReason: classification.reason,
    availability: "tentative",
    sourceLabel: task.sourceLabel,
    statusLabel: "Capacity-aligned local preview",
    mutabilityLabel: task.mutabilityLabel,
    detail: "Suggested from the strongest known capacity point. No task, source, or calendar record changed.",
    priority: "tentative",
    protected: false,
    synthetic: false,
  }];
};

const syntheticEvent = (
  date: string,
  key: string,
  title: string,
  type: string,
  startMinutes: number,
  endMinutes: number,
  availability: CalendarAvailability = "busy",
): CalendarEvent => {
  const classification = autoColorEvent({ title, type, source: "synthetic fixture extension" });
  return {
    id: `synthetic-${date}-${key}`,
    date,
    title,
    startMinutes,
    endMinutes,
    startLabel: formatMinute(startMinutes),
    endLabel: formatMinute(endMinutes),
    startAt: `${date}T${formatMinute(startMinutes)}:00`,
    endAt: `${date}T${formatMinute(endMinutes)}:00`,
    category: classification.category,
    categoryLabel: categoryById[classification.category].label,
    categorySymbol: categoryById[classification.category].symbol,
    colorReason: classification.reason,
    availability,
    sourceLabel: "Synthetic rhythm pattern",
    statusLabel: availability === "tentative" ? "Tentative fixture hold" : availability === "free" ? "Free reminder" : "Busy fixture block",
    mutabilityLabel: "Synthetic adjacent-day preview — local and read-only",
    detail: "Deterministic adjacent-day fixture extension. It is not a live import or persisted calendar event.",
    priority: availability === "tentative" ? "tentative" : type === "protected" ? "protected" : "standard",
    protected: type === "protected",
    synthetic: true,
  };
};

const adjacentEvents = (date: Temporal.PlainDate, fixtureDate: Temporal.PlainDate): CalendarEvent[] => {
  const offset = fixtureDate.until(date).days;
  if (offset === 0 || Math.abs(offset) > 10) return [];
  const value = date.toString();
  if (date.dayOfWeek === 1 || date.dayOfWeek === 3) return [syntheticEvent(value, "focus", "Deep-work block", "protected", 9 * 60, 10 * 60 + 30)];
  if (date.dayOfWeek === 2 || date.dayOfWeek === 4) return [
    syntheticEvent(value, "meeting", "Planning check-in", "hard", 13 * 60, 13 * 60 + 30),
    syntheticEvent(value, "buffer", "Recovery buffer", "recovery", 13 * 60 + 30, 13 * 60 + 45),
  ];
  if (date.dayOfWeek === 5) return [syntheticEvent(value, "personal", "Movement reminder", "personal", 12 * 60, 12 * 60 + 15, "free")];
  if (date.dayOfWeek === 7 && date.day % 2 === 0) return [syntheticEvent(value, "tentative", "Hold: weekly reset", "proposal", 16 * 60, 16 * 60 + 30, "tentative")];
  return [];
};

export const buildCalendarMonth = (projection: TodayProjectionV1): CalendarMonth => {
  const fixtureDate = Temporal.PlainDate.from(projection.date);
  const first = fixtureDate.with({ day: 1 });
  const gridStart = first.subtract({ days: first.dayOfWeek % 7 });
  const events = [
    ...projection.timeline.map((entry) => timelineEvent(entry, projection.timeZone)),
    ...deadlineEvents(projection),
    ...focusPreview(projection),
  ];
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = gridStart.add({ days: index });
    const dateString = date.toString();
    const dayEvents = [...events.filter((event) => event.date === dateString), ...adjacentEvents(date, fixtureDate)]
      .sort((left, right) => left.startMinutes - right.startMinutes || left.title.localeCompare(right.title));
    return {
      date: dateString,
      label: formatCalendarDate(dateString),
      dayNumber: date.day,
      inMonth: date.year === fixtureDate.year && date.month === fixtureDate.month,
      events: dayEvents,
    };
  });
  return {
    title: formatCalendarDate(projection.date, { month: "long", year: "numeric" }),
    selectedFixtureDate: projection.date,
    days,
  };
};

export type CalendarConflict = Readonly<{ first: CalendarEvent; second: CalendarEvent }>;
export type DayAvailability = Readonly<{
  meetingCount: number;
  busyMinutes: number;
  tentativeCount: number;
  conflicts: readonly CalendarConflict[];
  reason: string;
}>;

export const describeDayAvailability = (day: CalendarDay): DayAvailability => {
  const blocking = day.events.filter((event) => event.availability !== "free");
  const conflicts: CalendarConflict[] = [];
  for (let left = 0; left < blocking.length; left += 1) {
    for (let right = left + 1; right < blocking.length; right += 1) {
      if (blocking[left]!.startMinutes < blocking[right]!.endMinutes && blocking[right]!.startMinutes < blocking[left]!.endMinutes) {
        conflicts.push({ first: blocking[left]!, second: blocking[right]! });
      }
    }
  }
  const meetingCount = day.events.filter((event) => event.category === "meeting").length;
  const busyMinutes = day.events.filter((event) => event.availability === "busy").reduce((total, event) => total + Math.max(0, event.endMinutes - event.startMinutes), 0);
  const tentativeCount = day.events.filter((event) => event.availability === "tentative").length;
  const reason = conflicts[0]
    ? `${conflicts[0].first.title} overlaps ${conflicts[0].second.title}; the slot is unavailable.`
    : meetingCount >= 2
      ? `Daily meeting limit reached (${meetingCount}/2); new meeting slots are unavailable.`
      : day.events.some((event) => event.category === "focus" && event.protected)
        ? "Protected focus time blocks conflicting meetings; other gaps remain date-specific."
        : day.events.length === 0
          ? "No fixture blocks. A 24-hour minimum notice still applies to new meetings."
          : "Availability reflects busy, free, tentative, buffer, and minimum-notice rules.";
  return { meetingCount, busyMinutes, tentativeCount, conflicts, reason };
};

export type CalendarAgentIntent = "summary" | "conflicts" | "colors" | "protect-focus" | "unsupported";
export type CalendarAgentAction = Readonly<{ type: "reconfirm-colors"; eventIds: readonly string[] }>
  | Readonly<{ type: "protect-focus"; eventId: string }>;
export type CalendarAgentRequest = Readonly<{ prompt: string; day: CalendarDay }>;
export type CalendarAgentReply = Readonly<{ intent: CalendarAgentIntent; message: string; action?: CalendarAgentAction }>;
export interface CalendarAgentProvider {
  readonly id: string;
  respond(request: CalendarAgentRequest): Promise<CalendarAgentReply>;
}

export const localCalendarAgentReply = ({ prompt, day }: CalendarAgentRequest): CalendarAgentReply => {
  const normalized = prompt.trim().toLowerCase();
  const availability = describeDayAvailability(day);
  if (/\b(colou?rs?|categor(?:y|ies)|labels?)\b/.test(normalized)) {
    const reasons = day.events.slice(0, 4).map((event) => `${event.title}: ${event.categoryLabel.toLowerCase()} because ${event.colorReason.toLowerCase()}`);
    return {
      intent: "colors",
      message: day.events.length ? `Reconfirmed ${day.events.length} local event colors. ${reasons.join(" ")}` : "No events need color rules on this date.",
      action: { type: "reconfirm-colors", eventIds: day.events.map((event) => event.id) },
    };
  }
  if (/\b(protect|focus block|deep work)\b/.test(normalized)) {
    const focus = day.events.find((event) => event.category === "focus" && !event.protected)
      ?? day.events.find((event) => event.category === "focus");
    return focus
      ? { intent: "protect-focus", message: `Protected ${focus.title} in this local preview. Conflicting meetings are blocked; no source calendar changed.`, action: { type: "protect-focus", eventId: focus.id } }
      : { intent: "protect-focus", message: "No focus block exists on this date. Choose a date with a focus item; nothing was created or changed." };
  }
  if (/\b(conflicts?|unavailable|available|free|busy|why)\b/.test(normalized)) {
    return { intent: "conflicts", message: `${availability.reason} ${availability.tentativeCount} tentative item${availability.tentativeCount === 1 ? "" : "s"}; ${availability.busyMinutes} busy minutes. Buffers and the 24-hour minimum notice stay in force.` };
  }
  if (/\b(summary|summarize|agenda|selected day|today|day)\b/.test(normalized)) {
    const categories = [...new Set(day.events.map((event) => event.categoryLabel))];
    return { intent: "summary", message: `${day.label} has ${day.events.length} item${day.events.length === 1 ? "" : "s"}${categories.length ? ` across ${categories.join(", ")}` : ""}. ${availability.reason}` };
  }
  return { intent: "unsupported", message: "Local preview understands: summarize the selected day, explain conflicts, apply event colors, or protect a focus block. It cannot contact a provider or execute code." };
};

export const localCalendarAgent: CalendarAgentProvider = {
  id: "local-deterministic-preview",
  respond: async (request) => localCalendarAgentReply(request),
};
