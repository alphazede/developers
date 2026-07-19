export type RuntimeMode = "synthetic" | "live";

/** Startup composition only; synthetic is credential-free and the V1 default. */
export const loadRuntimeMode = (environment: Record<string, string | undefined> = process.env): RuntimeMode => {
  const mode = environment.APP_RUNTIME_MODE ?? "synthetic";
  if (mode === "synthetic" || mode === "live") return mode;
  throw new Error("APP_RUNTIME_MODE must be synthetic or live");
};
