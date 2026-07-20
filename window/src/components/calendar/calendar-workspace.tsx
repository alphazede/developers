"use client";

import { useMemo, useState, type FormEvent } from "react";

import type { TodayProjectionV1 } from "../../ui/projections";
import {
  buildCalendarMonth,
  calendarCategories,
  describeDayAvailability,
  formatCalendarDate,
  localCalendarAgent,
  type CalendarAgentReply,
  type CalendarDay,
} from "./calendar-model";

type ConversationMessage = Readonly<{ id: number; role: "user" | "assistant"; text: string }>;

export function CalendarWorkspace({ projection }: Readonly<{ projection: TodayProjectionV1 }>) {
  const month = useMemo(() => buildCalendarMonth(projection), [projection]);
  const [selectedDate, setSelectedDate] = useState(month.selectedFixtureDate);
  const [previewDate, setPreviewDate] = useState<string | null>(null);
  const [openEventId, setOpenEventId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [colorConfirmedIds, setColorConfirmedIds] = useState<readonly string[]>([]);
  const [protectedPreviewIds, setProtectedPreviewIds] = useState<readonly string[]>([]);
  const [conversation, setConversation] = useState<readonly ConversationMessage[]>([{
    id: 0,
    role: "assistant",
    text: "I can summarize the selected day, explain conflicts, color events, or protect focus time.",
  }]);
  const selectedDay = month.days.find((day) => day.date === selectedDate) ?? month.days[0]!;
  const availability = describeDayAvailability(selectedDay);

  const chooseDate = (day: CalendarDay) => {
    setSelectedDate(day.date);
    setOpenEventId(null);
  };

  const applyAgentAction = (reply: CalendarAgentReply) => {
    const action = reply.action;
    if (action?.type === "reconfirm-colors") setColorConfirmedIds(action.eventIds);
    if (action?.type === "protect-focus") setProtectedPreviewIds((current) => [...new Set([...current, action.eventId])]);
  };

  const submitPrompt = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = prompt.trim();
    if (!value) return;
    const requestId = conversation.length;
    setPrompt("");
    setConversation((current) => [...current, { id: requestId, role: "user", text: value }]);
    const reply = await localCalendarAgent.respond({ prompt: value, day: selectedDay });
    applyAgentAction(reply);
    setConversation((current) => [...current, { id: requestId + 1, role: "assistant", text: reply.message }]);
  };

  return (
    <section className="calendar-workspace" aria-labelledby="calendar-workspace-title" data-testid="calendar-workspace">
      <header className="calendar-workspace__header">
        <div>
          <p className="calendar-kicker">Planning view</p>
          <h1 id="calendar-workspace-title">Calendar</h1>
          <p>Choose a day to review its meetings, focus time, tasks, and recovery.</p>
        </div>
        <div className="calendar-local-boundary"><span aria-hidden="true">●</span> Demo data</div>
      </header>

      <div className="calendar-layout">
        <section className="calendar-month" aria-labelledby="calendar-month-title">
          <div className="calendar-month__heading">
            <div>
              <p className="calendar-kicker">Month view</p>
              <h2 id="calendar-month-title">{month.title}</h2>
            </div>
            <p><strong>{projection.focusGate.label}</strong><span> · 24-hour minimum notice</span></p>
          </div>

          <ul className="calendar-legend" aria-label="Calendar category legend">
            {calendarCategories.map((category) => <li key={category.id} data-category={category.id}>
              <span className="calendar-legend__mark" aria-hidden="true">{category.symbol}</span>{category.label}
            </li>)}
          </ul>

          <div className="calendar-weekdays" aria-hidden="true">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => <span key={day}>{day}</span>)}
          </div>
          <div className="calendar-days" aria-label={`${month.title} calendar`}>
            {month.days.map((day) => {
              const isSelected = day.date === selectedDate;
              const showsTooltip = day.date === previewDate;
              const tooltipId = `calendar-tooltip-${day.date}`;
              const summary = day.events.length
                ? `${day.events.length} items: ${day.events.map((item) => item.title).join(", ")}`
                : "No fixture events";
              return <div className="calendar-day" key={day.date} data-outside-month={!day.inMonth || undefined}>
                <button
                  type="button"
                  className="calendar-day__button"
                  data-selected={isSelected || undefined}
                  aria-pressed={isSelected}
                  aria-describedby={showsTooltip ? tooltipId : undefined}
                  aria-label={`Select ${day.label} — ${summary}`}
                  onClick={() => chooseDate(day)}
                  onMouseEnter={() => setPreviewDate(day.date)}
                  onMouseLeave={() => setPreviewDate((current) => current === day.date ? null : current)}
                  onFocus={() => setPreviewDate(day.date)}
                  onBlur={() => setPreviewDate((current) => current === day.date ? null : current)}
                >
                  <time dateTime={day.date}>{day.dayNumber}</time>
                  <span className="calendar-day__events" aria-hidden="true">
                    {day.events.slice(0, 2).map((item) => <span key={item.id} data-category={item.category}>
                      <b>{item.categorySymbol}</b> {item.title}
                    </span>)}
                    {day.events.length > 2 && <small>+{day.events.length - 2} more</small>}
                  </span>
                </button>
                {showsTooltip && <div className="calendar-tooltip" role="tooltip" id={tooltipId}>
                  <strong>{day.label}</strong>
                  <span>{summary}</span>
                </div>}
              </div>;
            })}
          </div>
        </section>

        <aside className="calendar-rundown" aria-labelledby="calendar-rundown-title" data-testid="calendar-rundown">
          <header className="calendar-rundown__header" aria-live="polite">
            <p className="calendar-kicker">Selected day</p>
            <h2 id="calendar-rundown-title">{formatCalendarDate(selectedDay.date)}</h2>
            <div className="availability-strip" aria-label="Day availability summary">
              <span><b>{Math.floor(availability.busyMinutes / 60)}h {availability.busyMinutes % 60}m</b> busy</span>
              <span><b>{availability.tentativeCount}</b> tentative</span>
              <span><b>{availability.meetingCount}/2</b> meetings</span>
            </div>
            <p className="availability-reason"><strong>Scheduling reason:</strong> {availability.reason}</p>
          </header>

          <section className="calendar-guardrails" aria-labelledby="calendar-guardrails-title">
            <h3 id="calendar-guardrails-title">Scheduling rules</h3>
            <ul>
              <li><strong>Focus protection</strong><span>Conflicting meetings blocked</span></li>
              <li><strong>Buffers</strong><span>15 minutes before or after</span></li>
              <li><strong>Meeting limit</strong><span>2 per day</span></li>
              <li><strong>Reusable types</strong><span>Focus 90m · Review 30m</span></li>
            </ul>
          </section>

          <section className="calendar-agenda" aria-labelledby="calendar-agenda-title">
            <div className="calendar-agenda__heading">
              <h3 id="calendar-agenda-title">Schedule</h3>
              <span>{selectedDay.events.length} {selectedDay.events.length === 1 ? "item" : "items"}</span>
            </div>
            {selectedDay.events.length === 0 ? <p className="calendar-empty">No fixture events. Date-specific availability and minimum notice still apply.</p> : <ol>
              {selectedDay.events.map((item) => {
                const expanded = openEventId === item.id;
                const protectedPreview = item.protected || protectedPreviewIds.includes(item.id);
                return <li key={item.id} data-category={item.category}>
                  <button
                    type="button"
                    className="calendar-agenda__event"
                    aria-expanded={expanded}
                    aria-label={`${item.startLabel} to ${item.endLabel}, ${item.title}, ${item.categoryLabel}, ${item.availability}, ${protectedPreview ? "protected" : item.priority}. ${expanded ? "Hide details" : "Show details"}`}
                    title={expanded ? "Hide event details" : "Show event details"}
                    data-color-confirmed={colorConfirmedIds.includes(item.id) || undefined}
                    data-protected-preview={protectedPreview || undefined}
                    onClick={() => setOpenEventId(expanded ? null : item.id)}
                  >
                    <span className="calendar-event-time"><time dateTime={item.startAt}>{item.startLabel}</time><small>{item.endLabel}</small></span>
                    <span className="calendar-event-copy"><strong>{item.title}</strong><small>{item.categorySymbol} {item.categoryLabel} · {item.availability}</small></span>
                    <span className="calendar-event-state">{protectedPreview ? "Protected" : item.priority}<span aria-hidden="true">{expanded ? "−" : "+"}</span></span>
                  </button>
                  {expanded && <div className="calendar-event-detail">
                    <p>{item.detail}</p>
                    <dl>
                      <div><dt>Source</dt><dd>{item.sourceLabel}{item.synthetic ? " · adjacent-day fixture" : ""}</dd></div>
                      <div><dt>Calendar state</dt><dd>{item.availability} · {item.statusLabel}</dd></div>
                      <div><dt>Color rule</dt><dd>{item.colorReason}</dd></div>
                      <div><dt>Authority</dt><dd>{item.mutabilityLabel}</dd></div>
                    </dl>
                  </div>}
                </li>;
              })}
            </ol>}
          </section>

          <section className="calendar-agent" aria-labelledby="calendar-agent-title">
            <div className="calendar-agent__heading">
              <div><p className="calendar-kicker">Local assistant</p><h3 id="calendar-agent-title">Ask Pennyworth</h3></div>
              <span>Offline demo</span>
            </div>
            <p className="calendar-agent__boundary">Pennyworth works only with this demo calendar. It is offline and cannot save changes or run code.</p>
            <div className="calendar-conversation" aria-live="polite" data-testid="calendar-agent-conversation">
              {conversation.map((message) => <p key={message.id} data-role={message.role}><strong>{message.role === "assistant" ? "Pennyworth" : "You"}</strong>{message.text}</p>)}
            </div>
            <form onSubmit={submitPrompt}>
              <label htmlFor="calendar-agent-prompt">Ask Pennyworth about {formatCalendarDate(selectedDay.date, { month: "short", day: "numeric" })}</label>
              <div>
                <input id="calendar-agent-prompt" value={prompt} onChange={(event) => setPrompt(event.currentTarget.value)} placeholder="Explain conflicts or protect a focus block" />
                <button type="submit">Send</button>
              </div>
              <small>Try “summarize this day”, “explain conflicts”, “apply event colors”, or “protect a focus block”.</small>
            </form>
          </section>
        </aside>
      </div>
    </section>
  );
}
