import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { gatewayOriginScope } from "../../packages/gateway-client/src/gateway-origin-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  coerceSecretRef,
  normalizeSecretInputString,
  type SecretInput,
} from "../config/types.secrets.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { materializeSecretInput } from "../secrets/resolve-secret-input-string.js";
import { findEdgeAuthIssue } from "../shared/gateway-edge-auth-headers.js";

export type EdgeAuthHeadersConfig = Record<string, SecretInput>;

function normalizeEdgeAuthSecretInput(value: unknown, headerName: string): SecretInput {
  const ref = coerceSecretRef(value);
  if (ref) {
    return ref;
  }
  const literal = normalizeSecretInputString(value);
  if (literal) {
    return literal;
  }
  throw new Error(
    `invalid gateway.remote.edgeAuth header "${headerName}": expected a non-empty SecretInput`,
  );
}

export function normalizeEdgeAuthHeadersConfig(value: unknown): EdgeAuthHeadersConfig | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("invalid gateway.remote.edgeAuth: expected a header map");
  }
  const shapeIssue = findEdgeAuthIssue(value);
  if (shapeIssue) {
    throw new Error(shapeIssue.message);
  }
  const entries = Object.entries(value);
  const normalizedEntries = entries.map(([headerName, input]) => {
    return [headerName, normalizeEdgeAuthSecretInput(input, headerName)] as const;
  });
  return Object.fromEntries(normalizedEntries);
}

/** Later headers replace earlier ones when names differ only by case, and keep the later name. */
export function overlayEdgeAuthHeadersConfig(
  base: EdgeAuthHeadersConfig | undefined,
  overlay: EdgeAuthHeadersConfig | undefined,
): EdgeAuthHeadersConfig | undefined {
  if (!overlay) {
    return base;
  }
  if (!base) {
    return overlay;
  }
  const overridden = new Set(Object.keys(overlay).map((name) => name.toLowerCase()));
  const merged: EdgeAuthHeadersConfig = {};
  for (const [name, value] of Object.entries(base)) {
    if (!overridden.has(name.toLowerCase())) {
      merged[name] = value;
    }
  }
  for (const [name, value] of Object.entries(overlay)) {
    merged[name] = value;
  }
  return merged;
}

export async function resolveEdgeAuthHeaders(params: {
  config: OpenClawConfig;
  value?: EdgeAuthHeadersConfig;
  targetUrl: string;
  env: NodeJS.ProcessEnv;
}): Promise<Readonly<Record<string, string>> | undefined> {
  if (!params.value) {
    return undefined;
  }
  let protocol: string;
  try {
    protocol = new URL(params.targetUrl).protocol;
  } catch {
    throw new Error("gateway.remote.edgeAuth requires a wss:// connection target");
  }
  if (protocol !== "wss:") {
    throw new Error("gateway.remote.edgeAuth requires a wss:// connection target");
  }
  const resolvedEntries = await Promise.all(
    Object.entries(params.value).map(async ([headerName, input]) => {
      const value = await materializeSecretInput({
        config: params.config,
        value: input,
        env: params.env,
      });
      if (!value) {
        throw new Error(`gateway.remote.edgeAuth header "${headerName}" resolved empty`);
      }
      registerSecretValueForRedaction(value);
      return [headerName, value] as const;
    }),
  );
  return Object.freeze(Object.fromEntries(resolvedEntries));
}

export function gatewayEdgeAuthValueForTarget(params: {
  config: OpenClawConfig;
  targetUrl: string;
}): unknown {
  const remote = params.config.gateway?.remote;
  if (!remote?.url || gatewayOriginScope(params.targetUrl) !== gatewayOriginScope(remote.url)) {
    return undefined;
  }
  return remote.edgeAuth;
}
