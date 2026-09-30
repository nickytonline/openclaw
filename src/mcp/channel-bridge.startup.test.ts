import { beforeEach, describe, expect, it, vi } from "vitest";
import type { resolveGatewayClientBootstrap } from "../gateway/client-bootstrap.js";

const mockState = vi.hoisted(() => ({
  clientOptions: null as Record<string, unknown> | null,
  autoHello: true,
}));

const resolveGatewayClientBootstrapMock = vi.hoisted(() =>
  vi.fn<typeof resolveGatewayClientBootstrap>(async () => ({
    url: "wss://127.0.0.1:18789",
    urlSource: "local loopback",
    connectionDetails: {
      url: "wss://127.0.0.1:18789",
      urlSource: "local loopback",
      message: "Gateway target: wss://127.0.0.1:18789",
    },
    tlsFingerprint: "sha256:local",
    auth: {
      token: undefined,
      password: undefined,
    },
  })),
);

vi.mock("../gateway/client-bootstrap.js", () => ({
  resolveGatewayClientBootstrap: resolveGatewayClientBootstrapMock,
}));

vi.mock("../gateway/client.js", () => ({
  GatewayClient: class MockGatewayClient {
    private readonly options: Record<string, unknown>;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      mockState.clientOptions = options;
    }

    start(): void {
      if (!mockState.autoHello) {
        return;
      }
      const onHelloOk = this.options.onHelloOk;
      if (typeof onHelloOk === "function") {
        onHelloOk();
      }
    }

    async request(): Promise<void> {}

    async stopAndWait(): Promise<void> {}
  },
}));

vi.mock("../../packages/gateway-client/src/readiness.js", () => ({
  startGatewayClientWhenEventLoopReady: vi.fn(async (client: { start: () => void }) => {
    client.start();
    return {
      ready: true,
      aborted: false,
      elapsedMs: 0,
      maxDriftMs: 0,
      checks: 1,
    };
  }),
}));

vi.mock("../gateway/method-scopes.js", () => ({
  APPROVALS_SCOPE: "operator.approvals",
  READ_SCOPE: "operator.read",
  WRITE_SCOPE: "operator.write",
}));

vi.mock("../../packages/gateway-protocol/src/client-info.js", () => ({
  GATEWAY_CLIENT_CAPS: { APPROVALS: "approvals" },
  GATEWAY_CLIENT_MODES: { CLI: "cli" },
  GATEWAY_CLIENT_NAMES: { CLI: "cli" },
}));

const { OpenClawChannelBridge } = await import("./channel-bridge.js");

const defaultBootstrapUrl = "wss://127.0.0.1:18789";

function bootstrapResult(url: string) {
  return {
    url,
    urlSource: "local loopback",
    connectionDetails: {
      url,
      urlSource: "local loopback" as const,
      message: `Gateway target: ${url}`,
    },
    tlsFingerprint: "sha256:local",
    auth: {
      token: undefined,
      password: undefined,
    },
  };
}

describe("OpenClawChannelBridge startup", () => {
  beforeEach(() => {
    mockState.clientOptions = null;
    mockState.autoHello = true;
    resolveGatewayClientBootstrapMock.mockReset();
    resolveGatewayClientBootstrapMock.mockImplementation(async () =>
      bootstrapResult(defaultBootstrapUrl),
    );
  });

  it("passes the resolved TLS fingerprint to the Gateway client", async () => {
    const bridge = new OpenClawChannelBridge({} as never, {
      claudeChannelMode: "off",
      verbose: false,
    });

    await bridge.start();

    expect(mockState.clientOptions?.tlsFingerprint).toBe("sha256:local");
    await bridge.close();
  });

  it("waits for the Gateway hello before completing startup", async () => {
    mockState.autoHello = false;
    const bridge = new OpenClawChannelBridge({} as never, {
      claudeChannelMode: "off",
      verbose: false,
    });

    const onStarted = vi.fn();
    const started = bridge.start().then(onStarted);
    await vi.waitFor(() => {
      expect(mockState.clientOptions).not.toBeNull();
    });
    expect(onStarted).not.toHaveBeenCalled();
    expect(mockState.clientOptions?.notifyOnStartupRetry).not.toBe(true);

    const onHelloOk = mockState.clientOptions?.onHelloOk;
    if (typeof onHelloOk !== "function") {
      throw new Error("Expected Gateway hello callback");
    }
    onHelloOk();

    await expect(started).resolves.toBeUndefined();
    await bridge.close();
  });

  it("sends configured edge auth only for the matching wss origin", async () => {
    const envName = "OPENCLAW_TEST_MCP_EDGE_AUTH";
    const previous = process.env[envName];
    process.env[envName] = "resolved-edge-token";
    resolveGatewayClientBootstrapMock.mockImplementation(async () =>
      bootstrapResult("wss://gateway.example/rpc"),
    );
    const bridge = new OpenClawChannelBridge(
      {
        gateway: {
          mode: "remote",
          remote: {
            url: "wss://gateway.example/rpc",
            edgeAuth: {
              "X-Edge-Auth": { source: "env", provider: "default", id: envName },
            },
          },
        },
      } as never,
      { claudeChannelMode: "off", verbose: false },
    );

    try {
      await bridge.start();
      expect(mockState.clientOptions?.edgeAuthHeaders).toEqual({
        "X-Edge-Auth": "resolved-edge-token",
      });
    } finally {
      if (previous === undefined) {
        delete process.env[envName];
      } else {
        process.env[envName] = previous;
      }
      await bridge.close();
    }
  });

  it("lets CLI upgrade headers replace configured headers by case-insensitive name", async () => {
    resolveGatewayClientBootstrapMock.mockImplementation(async () =>
      bootstrapResult("wss://gateway.example/rpc"),
    );
    const bridge = new OpenClawChannelBridge(
      {
        gateway: {
          mode: "remote",
          remote: {
            url: "wss://gateway.example/rpc",
            edgeAuth: {
              "X-Forwarded-User": { source: "env", provider: "default", id: "UNSET_EDGE_USER" },
              "X-Edge-Auth": "configured-secret",
            },
          },
        },
      } as never,
      {
        gatewayEdgeAuthHeaders: { "x-forwarded-user": "user@example.com" },
        claudeChannelMode: "off",
        verbose: false,
      },
    );

    await bridge.start();
    expect(mockState.clientOptions?.edgeAuthHeaders).toEqual({
      "X-Edge-Auth": "configured-secret",
      "x-forwarded-user": "user@example.com",
    });
    await bridge.close();
  });

  it("sends CLI upgrade headers when the target is outside the configured origin", async () => {
    resolveGatewayClientBootstrapMock.mockImplementation(async () =>
      bootstrapResult("wss://other.example/rpc"),
    );
    const bridge = new OpenClawChannelBridge(
      {
        gateway: {
          mode: "remote",
          remote: {
            url: "wss://gateway.example/rpc",
            edgeAuth: { "X-Edge-Auth": "configured-secret" },
          },
        },
      } as never,
      {
        gatewayEdgeAuthHeaders: { "x-forwarded-proto": "https" },
        claudeChannelMode: "off",
        verbose: false,
      },
    );

    await bridge.start();
    expect(mockState.clientOptions?.edgeAuthHeaders).toEqual({
      "x-forwarded-proto": "https",
    });
    await bridge.close();
  });

  it("omits edge auth headers when neither config nor CLI supplies them", async () => {
    const bridge = new OpenClawChannelBridge({} as never, {
      claudeChannelMode: "off",
      verbose: false,
    });

    await bridge.start();
    expect(mockState.clientOptions?.edgeAuthHeaders).toBeUndefined();
    await bridge.close();
  });

  it("refuses edge auth headers on ws:// before constructing the Gateway client", async () => {
    resolveGatewayClientBootstrapMock.mockImplementation(async () =>
      bootstrapResult("ws://gateway.example/rpc"),
    );
    const bridge = new OpenClawChannelBridge(
      {
        gateway: {
          mode: "remote",
          remote: {
            url: "ws://gateway.example/rpc",
            edgeAuth: {
              "X-Edge-Auth": { source: "env", provider: "default", id: "UNSET_EDGE_AUTH" },
            },
          },
        },
      } as never,
      {
        gatewayEdgeAuthHeaders: { "x-forwarded-user": "user@example.com" },
        claudeChannelMode: "off",
        verbose: false,
      },
    );

    await expect(bridge.start()).rejects.toThrow("edge auth headers require a wss:// Gateway URL");
    expect(mockState.clientOptions).toBeNull();
  });
});
