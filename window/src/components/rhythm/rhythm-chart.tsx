"use client";

import { useEffect, useRef, useState } from "react";

import type { AccessibleVisualizationV1 } from "../../contracts/v1";
import type { CapacityPointV1 } from "../../ui/projections";

export type RhythmChartProps = Readonly<{
  visualization: AccessibleVisualizationV1;
  capacityPoints: readonly CapacityPointV1[];
}>;

export function RhythmChart({ visualization, capacityPoints }: RhythmChartProps) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    let chart: { dispose: () => void; resize: () => void } | undefined;
    let observer: ResizeObserver | undefined;
    let cancelled = false;
    void import("echarts").then(({ init }) => {
      if (cancelled || !host.current) return;
      const instance = init(host.current, undefined, { renderer: "svg" });
      const resize = () => instance.resize();
      chart = { dispose: () => instance.dispose(), resize };
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      instance.setOption({
        animation: !reduced,
        aria: { enabled: true, decal: { show: true }, description: visualization.summary },
        color: ["#3b82f6", "#10b981", "#8b5cf6", "#6b7280"],
        textStyle: { color: "#374151", fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" },
        grid: { containLabel: true, left: 8, right: 8, top: 42, bottom: 28, borderColor: "#e5e7eb" },
        legend: { type: "scroll", textStyle: { color: "#374151" } },
        tooltip: { trigger: "axis" },
        xAxis: { type: "time", axisLabel: { hideOverlap: true, color: "#6b7280" }, axisLine: { lineStyle: { color: "#e5e7eb" } }, splitLine: { lineStyle: { color: "#f3f4f6" } } },
        yAxis: { type: "value", min: 0, max: 100, name: "0–100", axisLabel: { color: "#6b7280" }, splitLine: { lineStyle: { color: "#e5e7eb" } } },
        series: [
          ...visualization.series.map((series, index) => ({
            name: series.label,
            type: "line",
            connectNulls: false,
            showSymbol: true,
            symbol: ["circle", "diamond", "triangle", "rect"][index % 4],
            lineStyle: { type: index % 2 ? "dashed" : "solid" },
            data: series.points.map(({ x, y }) => [x, y]),
          })),
          {
            name: "Confidence band (%)",
            type: "line",
            symbol: "emptyCircle",
            lineStyle: { type: "dotted" },
            areaStyle: { opacity: 0.1 },
            data: capacityPoints.map((point) => [point.startAt, Math.round(point.confidence * 100)]),
          },
          {
            name: "Unknown capacity (◌)",
            type: "scatter",
            symbol: "emptyDiamond",
            data: capacityPoints.filter((point) => point.capacity === null).map((point) => [point.startAt, 0]),
          },
        ],
      });
      setStatus("ready");
      window.addEventListener("resize", resize);
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(resize);
        observer.observe(host.current);
      }
    }).catch(() => { if (!cancelled) setStatus("failed"); });
    return () => {
      cancelled = true;
      observer?.disconnect();
      if (chart) {
        window.removeEventListener("resize", chart.resize);
        chart.dispose();
      }
    };
  }, [capacityPoints, visualization]);

  return (
    <div className="rhythm-chart mt-4 min-w-0 max-w-full overflow-hidden" data-visualization-title={visualization.title}>
      <p role="status" aria-label="Optional chart status" className="text-sm font-semibold">
        {status === "loading" ? "Loading optional rhythm chart…" : status === "ready" ? "Optional rhythm chart ready." : "Optional rhythm chart unavailable; the complete text and table remain available."}
      </p>
      <div
        ref={host}
        role="img"
        aria-label={`Optional capacity chart. ${visualization.summary}`}
        className={`min-w-0 max-w-full overflow-hidden${status === "loading" ? " animate-pulse motion-reduce:animate-none" : ""}`}
        data-chart-status={status}
        style={{ width: "100%", height: "18rem", minWidth: 0, maxWidth: "100%", overflow: "hidden" }}
      />
    </div>
  );
}
