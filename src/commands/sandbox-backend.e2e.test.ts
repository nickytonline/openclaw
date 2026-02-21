import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  writeConfigFile: vi.fn(),
  logConfigUpdated: vi.fn(),
  resolveSandboxConfigForAgent: vi.fn(),
  runExec: vi.fn(),
  clackSelect: vi.fn(),
  clackText: vi.fn(),
  clackConfirm: vi.fn(),
  clackIntro: vi.fn(),
  clackOutro: vi.fn(),
  clackNote: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn(),
  osPlatform: vi.fn(),
  osUserInfo: vi.fn(),
  osHomedir: vi.fn(),
}));

vi.mock("node:os", () => ({
  default: {
    platform: () => mocks.osPlatform(),
    userInfo: () => mocks.osUserInfo(),
    homedir: () => mocks.osHomedir(),
  },
}));

vi.mock("@clack/prompts", () => ({
  select: mocks.clackSelect,
  text: mocks.clackText,
  confirm: mocks.clackConfirm,
  intro: mocks.clackIntro,
  outro: mocks.clackOutro,
  note: mocks.clackNote,
  cancel: mocks.cancel,
  isCancel: mocks.isCancel,
}));

vi.mock("../agents/sandbox/config.js", () => ({
  resolveSandboxConfigForAgent: mocks.resolveSandboxConfigForAgent,
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: mocks.loadConfig,
    writeConfigFile: mocks.writeConfigFile,
  };
});

vi.mock("../config/logging.js", () => ({
  logConfigUpdated: mocks.logConfigUpdated,
}));

vi.mock("../process/exec.js", () => ({
  runExec: mocks.runExec,
}));

vi.mock("../terminal/prompt-style.js", () => ({
  stylePromptMessage: (msg: string) => msg,
  stylePromptTitle: (msg: string) => msg,
}));

import { sandboxBackendCommand } from "./sandbox-backend.js";

// --- Test helpers ---

function createMockRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

type MockRuntime = ReturnType<typeof createMockRuntime>;

function expectLogContains(runtime: MockRuntime, text: string) {
  expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining(text));
}

function expectErrorContains(runtime: MockRuntime, text: string) {
  expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(text));
}

function setupDefaultMocks() {
  mocks.loadConfig.mockReturnValue({});
  mocks.writeConfigFile.mockResolvedValue(undefined);
  mocks.resolveSandboxConfigForAgent.mockReturnValue({ backend: "docker" });
  mocks.runExec.mockResolvedValue({ stdout: "", stderr: "" });
  mocks.isCancel.mockReturnValue(false);
  mocks.osPlatform.mockReturnValue("darwin");
  mocks.osUserInfo.mockReturnValue({ username: "testuser" });
  mocks.osHomedir.mockReturnValue("/home/testuser");
}

/**
 * Set up mocks so the Podman setup flow completes without cancellation.
 * Call after `setupDefaultMocks()`.
 */
function setupPodmanSetupDefaults() {
  // detectPodmanHost: id -u openclaw fails → falls back to current user,
  // id -u testuser succeeds, systemctl --version fails, etc.
  mocks.runExec.mockImplementation(async (cmd: string, args: string[]) => {
    if (cmd === "podman" && args[0] === "version") {
      return { stdout: "podman 4.0.0", stderr: "" };
    }
    if (cmd === "id" && args[0] === "-u") {
      if (args[1] === "openclaw") {
        throw new Error("no such user");
      }
      return { stdout: "1000", stderr: "" };
    }
    if (cmd === "systemctl") {
      throw new Error("not found");
    }
    if (cmd === "test") {
      throw new Error("not found");
    }
    return { stdout: "", stderr: "" };
  });

  // Queue: user prompt, subuid, subgid
  const textQueue = ["testuser", "100000:65536", "100000:65536"];
  mocks.clackText.mockImplementation(async () => textQueue.shift() ?? "");

  // Quadlet select → skip
  const selectQueue: string[] = [];
  mocks.clackSelect.mockImplementation(async () => {
    const queued = selectQueue.shift();
    if (queued !== undefined) {
      return queued;
    }
    return "skip";
  });
}

// --- Tests ---

describe("sandboxBackendCommand", () => {
  let runtime: MockRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
    runtime = createMockRuntime();
  });

  // --- JSON mode ---

  describe("JSON mode (--json)", () => {
    it("outputs current backend as JSON", async () => {
      await sandboxBackendCommand({ json: true }, runtime as never);

      const loggedJson = runtime.log.mock.calls[0][0];
      const parsed = JSON.parse(loggedJson);
      expect(parsed).toEqual({ backend: "docker", agentId: null });
    });

    it("includes agent ID when --agent specified", async () => {
      await sandboxBackendCommand({ json: true, agent: "work" }, runtime as never);

      const loggedJson = runtime.log.mock.calls[0][0];
      const parsed = JSON.parse(loggedJson);
      expect(parsed.agentId).toBe("work");
    });

    it("does not write config or show prompts", async () => {
      await sandboxBackendCommand({ json: true }, runtime as never);

      expect(mocks.writeConfigFile).not.toHaveBeenCalled();
      expect(mocks.clackSelect).not.toHaveBeenCalled();
      expect(mocks.clackIntro).not.toHaveBeenCalled();
    });
  });

  // --- Non-interactive mode ---

  describe("non-interactive mode (--set)", () => {
    it("rejects invalid backend", async () => {
      await sandboxBackendCommand({ json: false, set: "kubernetes" }, runtime as never);

      expectErrorContains(runtime, 'Invalid backend "kubernetes"');
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    });

    it("logs message when backend is already set", async () => {
      await sandboxBackendCommand({ json: false, set: "docker" }, runtime as never);

      expectLogContains(runtime, 'already set to "docker"');
      expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    });

    it("writes global default backend config", async () => {
      // Backend available
      mocks.runExec.mockResolvedValue({ stdout: "podman 4.0.0", stderr: "" });

      await sandboxBackendCommand({ json: false, set: "podman" }, runtime as never);

      expect(mocks.writeConfigFile).toHaveBeenCalledTimes(1);
      const written = mocks.writeConfigFile.mock.calls[0][0];
      expect(written.agents.defaults.sandbox.backend).toBe("podman");
      expect(mocks.logConfigUpdated).toHaveBeenCalled();
    });

    it("writes agent-specific backend config when --agent set", async () => {
      mocks.loadConfig.mockReturnValue({
        agents: { list: [{ id: "work" }] },
      });
      mocks.runExec.mockResolvedValue({ stdout: "podman 4.0.0", stderr: "" });

      await sandboxBackendCommand({ json: false, set: "podman", agent: "work" }, runtime as never);

      expect(mocks.writeConfigFile).toHaveBeenCalledTimes(1);
      const written = mocks.writeConfigFile.mock.calls[0][0];
      const entry = written.agents.list.find((e: Record<string, unknown>) => e.id === "work");
      expect(entry.sandbox.backend).toBe("podman");
    });

    it("creates agent entry if it does not exist", async () => {
      mocks.loadConfig.mockReturnValue({ agents: { list: [] } });
      mocks.runExec.mockResolvedValue({ stdout: "podman 4.0.0", stderr: "" });

      await sandboxBackendCommand(
        { json: false, set: "podman", agent: "newagent" },
        runtime as never,
      );

      const written = mocks.writeConfigFile.mock.calls[0][0];
      const entry = written.agents.list.find((e: Record<string, unknown>) => e.id === "newagent");
      expect(entry).toBeDefined();
      expect(entry.sandbox.backend).toBe("podman");
    });

    it("warns but still applies when backend not available", async () => {
      mocks.runExec.mockRejectedValue(new Error("not found"));

      await sandboxBackendCommand({ json: false, set: "podman" }, runtime as never);

      expectLogContains(runtime, "does not appear to be available");
      expect(mocks.writeConfigFile).toHaveBeenCalledTimes(1);
    });
  });

  // --- Interactive mode ---

  describe("interactive mode", () => {
    it("shows intro and select prompt", async () => {
      mocks.clackSelect.mockResolvedValue("docker");

      await sandboxBackendCommand({ json: false }, runtime as never);

      expect(mocks.clackIntro).toHaveBeenCalled();
      expect(mocks.clackSelect).toHaveBeenCalled();
    });

    it("cancels on user cancel", async () => {
      mocks.clackSelect.mockResolvedValue(Symbol.for("clack:cancel"));
      mocks.isCancel.mockReturnValue(true);

      await sandboxBackendCommand({ json: false }, runtime as never);

      expect(mocks.cancel).toHaveBeenCalledWith("Cancelled.");
      expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    });

    it("logs unchanged when same backend selected", async () => {
      mocks.clackSelect.mockResolvedValue("docker");

      await sandboxBackendCommand({ json: false }, runtime as never);

      expect(mocks.clackOutro).toHaveBeenCalledWith(expect.stringContaining("unchanged"));
      expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    });

    it("writes config when new backend selected", async () => {
      // First select: backend selection in interactive mode
      mocks.clackSelect.mockResolvedValueOnce("podman");
      // runExec for backend availability check succeeds
      mocks.runExec.mockResolvedValue({ stdout: "podman 4.0.0", stderr: "" });
      // Podman setup prompts
      setupPodmanSetupDefaults();

      await sandboxBackendCommand({ json: false }, runtime as never);

      expect(mocks.writeConfigFile).toHaveBeenCalled();
    });

    it("triggers Podman setup when switching to podman", async () => {
      mocks.clackSelect.mockResolvedValueOnce("podman");
      setupPodmanSetupDefaults();

      await sandboxBackendCommand({ json: false }, runtime as never);

      // Should have called clackNote for detection summary
      expect(mocks.clackNote).toHaveBeenCalled();
      // Should have prompted for user, subuid, subgid
      expect(mocks.clackText).toHaveBeenCalled();
    });

    it("shows outro with new backend name", async () => {
      mocks.clackSelect.mockResolvedValueOnce("podman");
      setupPodmanSetupDefaults();

      await sandboxBackendCommand({ json: false }, runtime as never);

      expect(mocks.clackOutro).toHaveBeenCalledWith(expect.stringContaining("podman"));
    });
  });

  // --- Podman setup flow ---

  describe("Podman setup flow", () => {
    beforeEach(() => {
      // Set up so we always reach the Podman setup flow:
      // interactive mode → select podman → write config → run setup
      mocks.clackSelect.mockResolvedValueOnce("podman");
      mocks.runExec.mockResolvedValue({ stdout: "", stderr: "" });
    });

    it("shows note when podman is not available", async () => {
      setupPodmanSetupDefaults();
      // Override: podman not available
      mocks.runExec.mockImplementation(async (cmd: string, args: string[]) => {
        if (cmd === "podman") {
          throw new Error("not found");
        }
        if (cmd === "id" && args[0] === "-u") {
          if (args[1] === "openclaw") {
            throw new Error("no such user");
          }
          return { stdout: "1000", stderr: "" };
        }
        if (cmd === "systemctl") {
          throw new Error("not found");
        }
        throw new Error("not found");
      });

      await sandboxBackendCommand({ json: false }, runtime as never);

      expectLogContains(runtime, "Podman is not installed");
    });

    it("shows remote host note on non-Linux", async () => {
      mocks.osPlatform.mockReturnValue("darwin");
      setupPodmanSetupDefaults();

      await sandboxBackendCommand({ json: false }, runtime as never);

      expectLogContains(runtime, "remote host");
    });

    it("prints manual subuid/subgid commands on non-Linux", async () => {
      mocks.osPlatform.mockReturnValue("darwin");
      setupPodmanSetupDefaults();

      await sandboxBackendCommand({ json: false }, runtime as never);

      expectLogContains(runtime, "On the target Linux host, run:");
      expectLogContains(runtime, "/etc/subuid");
      expectLogContains(runtime, "/etc/subgid");
    });

    it("cancels when user prompt is cancelled", async () => {
      setupPodmanSetupDefaults();
      mocks.clackText.mockResolvedValueOnce(Symbol.for("clack:cancel"));
      mocks.isCancel.mockImplementation((v) => typeof v === "symbol");

      await sandboxBackendCommand({ json: false }, runtime as never);

      expect(mocks.cancel).toHaveBeenCalledWith("Cancelled.");
    });

    it("cancels when subuid prompt is cancelled", async () => {
      setupPodmanSetupDefaults();
      // user prompt succeeds, subuid cancelled
      mocks.clackText
        .mockResolvedValueOnce("testuser")
        .mockResolvedValueOnce(Symbol.for("clack:cancel"));
      mocks.isCancel.mockImplementation((v) => typeof v === "symbol");

      await sandboxBackendCommand({ json: false }, runtime as never);

      expect(mocks.cancel).toHaveBeenCalledWith("Cancelled.");
    });

    it("cancels when subgid prompt is cancelled", async () => {
      setupPodmanSetupDefaults();
      mocks.clackText
        .mockResolvedValueOnce("testuser")
        .mockResolvedValueOnce("100000:65536")
        .mockResolvedValueOnce(Symbol.for("clack:cancel"));
      mocks.isCancel.mockImplementation((v) => typeof v === "symbol");

      await sandboxBackendCommand({ json: false }, runtime as never);

      expect(mocks.cancel).toHaveBeenCalledWith("Cancelled.");
    });

    it("cancels when Quadlet prompt is cancelled", async () => {
      setupPodmanSetupDefaults();
      mocks.clackText
        .mockResolvedValueOnce("testuser")
        .mockResolvedValueOnce("100000:65536")
        .mockResolvedValueOnce("100000:65536");
      // Override select: first call was consumed by the backend selection,
      // second call is the Quadlet prompt
      mocks.clackSelect.mockResolvedValueOnce(Symbol.for("clack:cancel"));
      mocks.isCancel.mockImplementation((v) => typeof v === "symbol");

      await sandboxBackendCommand({ json: false }, runtime as never);

      expect(mocks.cancel).toHaveBeenCalledWith("Cancelled.");
    });

    it("shows Quadlet prompt even without systemd", async () => {
      mocks.osPlatform.mockReturnValue("darwin");
      setupPodmanSetupDefaults();

      await sandboxBackendCommand({ json: false }, runtime as never);

      // clackNote called for systemd not detected
      expect(mocks.clackNote).toHaveBeenCalledWith(
        expect.stringContaining("systemd not detected"),
        "Quadlet",
      );
      // Select was called for both backend and Quadlet
      expect(mocks.clackSelect.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("prints manual Quadlet commands on non-Linux when install selected", async () => {
      mocks.osPlatform.mockReturnValue("darwin");
      setupPodmanSetupDefaults();
      mocks.clackText
        .mockResolvedValueOnce("testuser")
        .mockResolvedValueOnce("100000:65536")
        .mockResolvedValueOnce("100000:65536");
      // First select consumed by backend prompt, second is Quadlet
      mocks.clackSelect.mockResolvedValueOnce("install");
      mocks.isCancel.mockReturnValue(false);

      await sandboxBackendCommand({ json: false }, runtime as never);

      expectLogContains(runtime, "On the target Linux host, create the Quadlet unit:");
      expectLogContains(runtime, ".config/containers/systemd");
    });
  });
});
