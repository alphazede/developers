/**
 * Error handling for the AlphaZede Sports MCP Server.
 *
 * Maps HTTP status codes and network errors to user-friendly MCP responses.
 * Never exposes internal details, stack traces, or implementation specifics.
 */

import type { ErrorDetail, ErrorResponse } from "./public-types.js";

export class AzsApiError extends Error {
  readonly statusCode: number;
  readonly userMessage: string;
  readonly code?: string;

  constructor(statusCode: number, userMessage: string, code?: string) {
    super(userMessage);
    this.name = "AzsApiError";
    this.statusCode = statusCode;
    this.userMessage = userMessage;
    this.code = code;
  }
}

/**
 * Map an HTTP status code to a user-friendly error message.
 */
export function mapHttpError(statusCode: number): string {
  if (statusCode === 400) {
    return "Invalid request parameters. Please check your input and try again.";
  }
  if (statusCode === 401) {
    return "Invalid or missing API key. Please check your host secret configuration.";
  }
  if (statusCode === 402) {
    return "This feature requires a paid subscription. Please upgrade your plan.";
  }
  if (statusCode === 403) {
    return "This feature is not available on your current plan. Upgrade to Pro for the full MCP tool matrix.";
  }
  if (statusCode === 404) {
    return "No data found for the requested game, prop, or sport.";
  }
  if (statusCode === 429) {
    return "Rate limit exceeded. Please wait before making another request.";
  }
  if (statusCode >= 500) {
    return "AlphaZede Sports service error. Try again in a moment.";
  }
  return "An unexpected error occurred. Try again in a moment.";
}

/**
 * Map a network/fetch error to a user-friendly message.
 */
export function mapNetworkError(error: unknown): string {
  // Detect AbortError (request timeout)
  if (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return "Request timed out. The AlphaZede Sports API may be experiencing high load. Try again in a moment.";
  }
  return "The AlphaZede Sports API is currently unavailable. Try again in a moment.";
}

/**
 * Create a AzsApiError from an HTTP response status code.
 */
export function errorFromStatus(statusCode: number): AzsApiError {
  return new AzsApiError(
    statusCode,
    mapHttpError(statusCode),
    `http_${statusCode}`,
  );
}

/**
 * Try to parse an API error envelope from an HTTP response body.
 * Returns the error code/message if parseable, null otherwise.
 */
export async function parseAzsErrorBody(
  response: Response,
): Promise<Pick<ErrorDetail, "code" | "message"> | null> {
  try {
    const body = (await response.json()) as unknown;
    if (body && typeof body === "object" && "error" in body) {
      const err = (body as ErrorResponse).error as unknown;
      if (typeof err === "object" && err !== null) {
        return {
          code:
            "code" in err && typeof err.code === "string"
              ? err.code
              : "UNKNOWN",
          message:
            "message" in err && typeof err.message === "string"
              ? err.message
              : "",
        };
      }
      // Simple string error
      if (typeof err === "string") {
        return { code: "UNKNOWN", message: err };
      }
    }
  } catch {
    // Body not parseable as JSON -- fall through
  }
  return null;
}
