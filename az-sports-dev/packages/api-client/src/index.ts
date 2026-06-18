import { operations, type OperationId } from "./operations.js";

export type Primitive = string | number | boolean;

export type QueryValue = Primitive | null | undefined | readonly Primitive[];

export type AzsClientOptions = {
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  headers?: HeadersInit;
};

export type OperationRequest = {
  body?: unknown;
  headers?: HeadersInit;
  path?: Record<string, Primitive>;
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
};

export type AzsClient = {
  request<TResponse = unknown>(
    operationId: OperationId,
    request?: OperationRequest,
  ): Promise<TResponse>;
} & {
  [TOperationId in OperationId]: <TResponse = unknown>(
    request?: OperationRequest,
  ) => Promise<TResponse>;
};

export class AzsApiError extends Error {
  readonly body: unknown;
  readonly operationId: OperationId;
  readonly status: number;

  constructor({
    body,
    operationId,
    status,
  }: {
    body: unknown;
    operationId: OperationId;
    status: number;
  }) {
    super(`AlphaZede Sports API request failed: ${operationId} returned ${status}`);
    this.name = "AzsApiError";
    this.body = body;
    this.operationId = operationId;
    this.status = status;
  }
}

export function createAzsClient(options: AzsClientOptions = {}): AzsClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? "https://api.alphazedesports.com");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("createAzsClient requires a fetch implementation");
  }

  const request = async <TResponse = unknown>(
    operationId: OperationId,
    requestOptions: OperationRequest = {},
  ): Promise<TResponse> => {
    const operation = operations[operationId];
    if (!operation) {
      throw new Error(`Unknown AlphaZede Sports operation: ${String(operationId)}`);
    }

    const url = new URL(applyPathParams(operation.path, requestOptions.path), baseUrl);
    appendQuery(url, requestOptions.query);

    const headers = new Headers(options.headers);
    mergeHeaders(headers, requestOptions.headers);
    if (options.apiKey && !headers.has("authorization")) {
      headers.set("authorization", `Bearer ${options.apiKey}`);
    }
    if (requestOptions.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    if (!headers.has("accept")) {
      headers.set("accept", "application/json");
    }

    const response = await fetchImpl(url, {
      body: requestOptions.body === undefined
        ? undefined
        : JSON.stringify(requestOptions.body),
      headers,
      method: operation.method,
      signal: requestOptions.signal,
    });
    const body = await readResponseBody(response);
    if (!response.ok) {
      throw new AzsApiError({ body, operationId, status: response.status });
    }
    return body as TResponse;
  };

  const client = { request } as AzsClient;
  for (const operationId of Object.keys(operations) as OperationId[]) {
    client[operationId] = (requestOptions) => request(operationId, requestOptions);
  }
  return client;
}

async function readResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new Error("baseUrl must not be empty");
  }
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function applyPathParams(
  pathTemplate: string,
  pathParams: Record<string, Primitive> = {},
): string {
  return pathTemplate.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    if (!(key in pathParams)) {
      throw new Error(`Missing path parameter: ${key}`);
    }
    return encodeURIComponent(String(pathParams[key]));
  });
}

function appendQuery(url: URL, query: Record<string, QueryValue> = {}): void {
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, String(item));
      }
      continue;
    }
    url.searchParams.set(key, String(value));
  }
}

function mergeHeaders(target: Headers, source: HeadersInit | undefined): void {
  if (!source) {
    return;
  }
  const headers = new Headers(source);
  headers.forEach((value, key) => {
    target.set(key, value);
  });
}

export { operations, type OperationId };
