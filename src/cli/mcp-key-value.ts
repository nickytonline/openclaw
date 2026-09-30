import { formatErrorMessage } from "../infra/errors.js";

export function parseKeyValueEntries(
  values: readonly string[] | undefined,
  label: string,
  fail: (message: string) => never,
): Record<string, string> | undefined {
  const entries: Record<string, string> = {};
  for (const raw of values ?? []) {
    const separatorIndex = raw.indexOf("=");
    if (separatorIndex <= 0) {
      fail(`${label} entries must use KEY=VALUE.`);
    }
    const key = raw.slice(0, separatorIndex).trim();
    const value = raw.slice(separatorIndex + 1);
    if (!key) {
      fail(`${label} entries must use a non-empty key.`);
    }
    entries[key] = value;
  }
  return Object.keys(entries).length > 0 ? entries : undefined;
}

export async function parseMcpServeEdgeAuthHeaders(
  values: readonly string[] | undefined,
  fail: (message: string) => never,
): Promise<Record<string, string> | undefined> {
  const parsed = parseKeyValueEntries(values, "--header", fail);
  if (!parsed) {
    return undefined;
  }
  try {
    const { normalizeEdgeAuthHeadersConfig } = await import("../gateway/edge-auth.js");
    const normalized = normalizeEdgeAuthHeadersConfig(parsed);
    if (!normalized) {
      return undefined;
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(normalized)) {
      if (typeof value !== "string") {
        throw new Error(`--header ${JSON.stringify(name)} must be a literal value.`);
      }
      headers[name] = value;
    }
    return headers;
  } catch (error) {
    return fail(formatErrorMessage(error));
  }
}
