export class RequestBoundaryError extends Error {
  constructor(readonly code: "PAYLOAD_TOO_LARGE" | "CONTENT_LENGTH_MISMATCH" | "INVALID_JSON", readonly status: 400 | 413) { super(code); }
}

const declaredLength = (request: Request, maximumBytes: number): number | null => {
  const header = request.headers.get("content-length");
  if (header === null) return null;
  if (!/^\d+$/.test(header) || !Number.isSafeInteger(Number(header))) throw new RequestBoundaryError("CONTENT_LENGTH_MISMATCH", 400);
  const length = Number(header);
  if (length > maximumBytes) throw new RequestBoundaryError("PAYLOAD_TOO_LARGE", 413);
  return length;
};

export const readBoundedBytes = async (request: Request, maximumBytes: number): Promise<Uint8Array> => {
  const declared = declaredLength(request, maximumBytes), reader = request.body?.getReader();
  if (!reader) {
    if (declared !== null && declared !== 0) throw new RequestBoundaryError("CONTENT_LENGTH_MISMATCH", 400);
    return new Uint8Array();
  }
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) { await reader.cancel(); throw new RequestBoundaryError("PAYLOAD_TOO_LARGE", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (declared !== null && declared !== total) throw new RequestBoundaryError("CONTENT_LENGTH_MISMATCH", 400);
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
};

const rejectDuplicateObjectKeys = (text: string) => {
  const containers: (Set<string> | null)[] = []; let inString = false, escaped = false, stringStart = -1;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (character === "\\") { escaped = true; continue; }
      if (character !== '"') continue;
      inString = false;
      const keys = containers.at(-1); if (!keys) continue;
      let next = index + 1; while (/\s/.test(text[next] ?? "")) next += 1;
      if (text[next] !== ":") continue;
      const key = JSON.parse(text.slice(stringStart, index + 1)) as string;
      if (keys.has(key)) throw new RequestBoundaryError("INVALID_JSON", 400);
      keys.add(key);
      continue;
    }
    if (character === '"') { inString = true; stringStart = index; continue; }
    if (character === "{") containers.push(new Set());
    else if (character === "[") containers.push(null);
    else if (character === "}" || character === "]") containers.pop();
  }
};

export const readBoundedJsonObject = async (request: Request, maximumBytes: number): Promise<Record<string, unknown>> => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedBytes(request, maximumBytes));
    rejectDuplicateObjectKeys(text);
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RequestBoundaryError) throw error;
    throw new RequestBoundaryError("INVALID_JSON", 400);
  }
};

export const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).sort().join() === [...keys].sort().join();
