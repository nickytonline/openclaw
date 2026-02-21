import os from "node:os";
import {
  cancel,
  confirm as clackConfirm,
  intro as clackIntro,
  isCancel,
  note as clackNote,
  outro as clackOutro,
  select as clackSelect,
  text as clackText,
} from "@clack/prompts";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import type { SandboxBackend } from "../agents/sandbox/types.js";
import { loadConfig, writeConfigFile } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import { runExec } from "../process/exec.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { stylePromptMessage, stylePromptTitle } from "../terminal/prompt-style.js";

type SandboxBackendOptions = {
  set?: string;
  agent?: string;
  json: boolean;
};

const VALID_BACKENDS: SandboxBackend[] = ["docker", "podman"];

async function isBackendAvailable(backend: SandboxBackend): Promise<boolean> {
  try {
    await runExec(backend, ["version"], { timeoutMs: 5_000 });
    return true;
  } catch {
    return false;
  }
}

// --- Podman host detection helpers ---

type PodmanHostInfo = {
  podmanAvailable: boolean;
  user: string;
  userExists: boolean;
  hasSubuid: boolean;
  hasSubgid: boolean;
  subuidRange: string | undefined;
  subgidRange: string | undefined;
  systemdAvailable: boolean;
  quadletInstalled: boolean;
  platform: string;
};

async function detectPodmanHost(): Promise<PodmanHostInfo> {
  const platform = os.platform();
  const currentUser = os.userInfo().username;

  // Check if podman is installed.
  const podmanAvailable = await isBackendAvailable("podman");

  // Detect user: prefer existing "openclaw" user, fall back to current user.
  let user = currentUser;
  let userExists = true;
  try {
    await runExec("id", ["-u", "openclaw"], { timeoutMs: 3_000 });
    user = "openclaw";
  } catch {
    // openclaw user doesn't exist; use current user.
  }

  // Check subuid/subgid for the target user.
  let hasSubuid = false;
  let hasSubgid = false;
  let subuidRange: string | undefined;
  let subgidRange: string | undefined;

  if (platform === "linux") {
    try {
      const { stdout } = await runExec("grep", [`^${user}:`, "/etc/subuid"], {
        timeoutMs: 3_000,
      });
      const line = stdout.trim();
      if (line) {
        hasSubuid = true;
        subuidRange = line;
      }
    } catch {
      // No subuid entry.
    }

    try {
      const { stdout } = await runExec("grep", [`^${user}:`, "/etc/subgid"], {
        timeoutMs: 3_000,
      });
      const line = stdout.trim();
      if (line) {
        hasSubgid = true;
        subgidRange = line;
      }
    } catch {
      // No subgid entry.
    }
  }

  // Check if the user actually exists (relevant if auto-detected "openclaw" but want to verify).
  try {
    await runExec("id", ["-u", user], { timeoutMs: 3_000 });
    userExists = true;
  } catch {
    userExists = false;
  }

  // Check systemd availability.
  let systemdAvailable = false;
  try {
    await runExec("systemctl", ["--version"], { timeoutMs: 3_000 });
    systemdAvailable = true;
  } catch {
    // No systemd.
  }

  // Check if Quadlet unit is already installed for the user.
  let quadletInstalled = false;
  if (systemdAvailable && userExists) {
    try {
      const homeDir =
        user === currentUser
          ? os.homedir()
          : (await runExec("bash", ["-c", `echo ~${user}`], { timeoutMs: 3_000 })).stdout.trim();
      const quadletPath = `${homeDir}/.config/containers/systemd/openclaw.container`;
      await runExec("test", ["-f", quadletPath], { timeoutMs: 3_000 });
      quadletInstalled = true;
    } catch {
      // No quadlet unit.
    }
  }

  return {
    podmanAvailable,
    user,
    userExists,
    hasSubuid,
    hasSubgid,
    subuidRange,
    subgidRange,
    systemdAvailable,
    quadletInstalled,
    platform,
  };
}

function formatDetectionSummary(info: PodmanHostInfo): string {
  const lines: string[] = [];
  lines.push(`Platform:  ${info.platform}`);
  lines.push(`Podman:    ${info.podmanAvailable ? "installed" : "not found"}`);
  lines.push(`User:      ${info.user}${info.userExists ? "" : " (does not exist)"}`);
  if (info.platform === "linux") {
    lines.push(`subuid:    ${info.hasSubuid ? info.subuidRange : "not configured"}`);
    lines.push(`subgid:    ${info.hasSubgid ? info.subgidRange : "not configured"}`);
  }
  if (info.systemdAvailable) {
    lines.push(`Quadlet:   ${info.quadletInstalled ? "installed" : "not installed"}`);
  }
  return lines.join("\n");
}

/** Parse a "user:start:count" range string into parts. */
function parseSubidRange(range: string): { start: string; count: string } | undefined {
  const parts = range.split(":");
  if (parts.length >= 3) {
    return { start: parts[1], count: parts[2] };
  }
  return undefined;
}

/** Re-check subuid/subgid for a specific user. */
async function checkSubids(user: string): Promise<{
  hasSubuid: boolean;
  hasSubgid: boolean;
  subuidRange: string | undefined;
  subgidRange: string | undefined;
}> {
  let hasSubuid = false;
  let hasSubgid = false;
  let subuidRange: string | undefined;
  let subgidRange: string | undefined;

  try {
    const { stdout } = await runExec("grep", [`^${user}:`, "/etc/subuid"], { timeoutMs: 3_000 });
    const line = stdout.trim();
    if (line) {
      hasSubuid = true;
      subuidRange = line;
    }
  } catch {
    // No entry.
  }
  try {
    const { stdout } = await runExec("grep", [`^${user}:`, "/etc/subgid"], { timeoutMs: 3_000 });
    const line = stdout.trim();
    if (line) {
      hasSubgid = true;
      subgidRange = line;
    }
  } catch {
    // No entry.
  }

  return { hasSubuid, hasSubgid, subuidRange, subgidRange };
}

async function runPodmanSetup(runtime: RuntimeEnv): Promise<void> {
  const info = await detectPodmanHost();
  clackNote(formatDetectionSummary(info), "Podman host detection");

  const isLinux = info.platform === "linux";

  if (!info.podmanAvailable) {
    runtime.log(
      "Note: Podman is not installed on this system.\n" +
        "  Install: https://podman.io/docs/installation",
    );
  }

  if (!isLinux) {
    runtime.log("Note: Podman sandbox requires Linux. Configuring for a remote host.");
  }

  // --- User (required for rootless Podman) ---
  const userResult = await clackText({
    message: stylePromptMessage("Podman user for sandbox containers"),
    initialValue: info.user,
    placeholder: info.user,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });

  if (isCancel(userResult)) {
    cancel("Cancelled.");
    return;
  }

  const podmanUser = userResult.trim() || info.user;

  // Check if user needs to be created (only on Linux).
  if (isLinux) {
    let userExistsNow = info.userExists && podmanUser === info.user;
    if (podmanUser !== info.user) {
      try {
        await runExec("id", ["-u", podmanUser], { timeoutMs: 3_000 });
        userExistsNow = true;
      } catch {
        userExistsNow = false;
      }
    }

    if (!userExistsNow) {
      const createUser = await clackConfirm({
        message: stylePromptMessage(
          `User "${podmanUser}" does not exist. Create it? (requires sudo)`,
        ),
        initialValue: true,
      });

      if (isCancel(createUser)) {
        cancel("Cancelled.");
        return;
      }

      if (createUser) {
        try {
          await runExec("sudo", ["useradd", "-m", "-s", "/usr/sbin/nologin", podmanUser], {
            timeoutMs: 30_000,
          });
          runtime.log(`Created user "${podmanUser}".`);

          // Enable lingering for rootless Podman.
          try {
            await runExec("sudo", ["loginctl", "enable-linger", podmanUser], {
              timeoutMs: 5_000,
            });
          } catch {
            // Non-fatal.
          }
        } catch (err) {
          runtime.error(`Failed to create user: ${String(err)}`);
          runtime.log("Create the user manually and re-run this command.");
          return;
        }
      } else {
        runtime.log(
          `Skipped. Create the user manually:\n  sudo useradd -m -s /usr/sbin/nologin ${podmanUser}`,
        );
      }
    }
  }

  // --- subuid/subgid (required for rootless Podman) ---
  const subids = isLinux
    ? await checkSubids(podmanUser)
    : { hasSubuid: false, hasSubgid: false, subuidRange: undefined, subgidRange: undefined };
  const defaultStart = "100000";
  const defaultCount = "65536";

  // subuid
  const existingSubuid = subids.subuidRange ? parseSubidRange(subids.subuidRange) : undefined;
  const subuidStartDefault = existingSubuid?.start ?? defaultStart;
  const subuidCountDefault = existingSubuid?.count ?? defaultCount;

  const subuidResult = await clackText({
    message: stylePromptMessage(`Subordinate UID range for "${podmanUser}" (start:count)`),
    initialValue: `${subuidStartDefault}:${subuidCountDefault}`,
    placeholder: `${defaultStart}:${defaultCount}`,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });

  if (isCancel(subuidResult)) {
    cancel("Cancelled.");
    return;
  }

  const subuidValue = subuidResult.trim();

  // subgid
  const existingSubgid = subids.subgidRange ? parseSubidRange(subids.subgidRange) : undefined;
  const subgidStartDefault = existingSubgid?.start ?? defaultStart;
  const subgidCountDefault = existingSubgid?.count ?? defaultCount;

  const subgidResult = await clackText({
    message: stylePromptMessage(`Subordinate GID range for "${podmanUser}" (start:count)`),
    initialValue: `${subgidStartDefault}:${subgidCountDefault}`,
    placeholder: `${defaultStart}:${defaultCount}`,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });

  if (isCancel(subgidResult)) {
    cancel("Cancelled.");
    return;
  }

  const subgidValue = subgidResult.trim();

  // Apply subuid/subgid (only on Linux where /etc/subuid and /etc/subgid exist).
  const desiredSubuid = `${podmanUser}:${subuidValue}`;
  const desiredSubgid = `${podmanUser}:${subgidValue}`;

  if (isLinux) {
    if (!subids.hasSubuid || subids.subuidRange !== desiredSubuid) {
      try {
        if (subids.hasSubuid) {
          await runExec(
            "sudo",
            ["bash", "-c", `sed -i 's/^${podmanUser}:.*/${desiredSubuid}/' /etc/subuid`],
            { timeoutMs: 10_000 },
          );
        } else {
          await runExec("sudo", ["bash", "-c", `echo '${desiredSubuid}' >> /etc/subuid`], {
            timeoutMs: 10_000,
          });
        }
        runtime.log(`subuid: ${desiredSubuid}`);
      } catch (err) {
        runtime.error(`Failed to set subuid: ${String(err)}`);
        runtime.log(`Set manually:\n  echo '${desiredSubuid}' | sudo tee -a /etc/subuid`);
      }
    } else {
      runtime.log(`subuid: ${desiredSubuid} (unchanged)`);
    }

    if (!subids.hasSubgid || subids.subgidRange !== desiredSubgid) {
      try {
        if (subids.hasSubgid) {
          await runExec(
            "sudo",
            ["bash", "-c", `sed -i 's/^${podmanUser}:.*/${desiredSubgid}/' /etc/subgid`],
            { timeoutMs: 10_000 },
          );
        } else {
          await runExec("sudo", ["bash", "-c", `echo '${desiredSubgid}' >> /etc/subgid`], {
            timeoutMs: 10_000,
          });
        }
        runtime.log(`subgid: ${desiredSubgid}`);
      } catch (err) {
        runtime.error(`Failed to set subgid: ${String(err)}`);
        runtime.log(`Set manually:\n  echo '${desiredSubgid}' | sudo tee -a /etc/subgid`);
      }
    } else {
      runtime.log(`subgid: ${desiredSubgid} (unchanged)`);
    }
  } else {
    runtime.log(`\nOn the target Linux host, run:`);
    runtime.log(`  echo '${desiredSubuid}' | sudo tee -a /etc/subuid`);
    runtime.log(`  echo '${desiredSubgid}' | sudo tee -a /etc/subgid`);
  }

  // --- Quadlet (optional) ---
  if (!info.systemdAvailable) {
    clackNote("systemd not detected — Quadlet options shown for remote host setup.", "Quadlet");
  }
  const quadletDefault = info.quadletInstalled ? "installed" : "not installed";
  const installQuadlet = await clackSelect({
    message: stylePromptMessage(`Quadlet systemd unit (optional, currently ${quadletDefault})`),
    options: [
      {
        value: "skip" as const,
        label: "Skip",
        hint: info.quadletInstalled ? "Keep existing Quadlet unit" : "Do not install",
      },
      {
        value: "install" as const,
        label: "Install",
        hint: "Install/overwrite rootless Podman user service",
      },
    ],
    initialValue: "skip" as const,
  });

  if (isCancel(installQuadlet)) {
    cancel("Cancelled.");
    return;
  }

  if (installQuadlet === "install") {
    if (isLinux && info.systemdAvailable) {
      try {
        const homeDir = (
          await runExec("bash", ["-c", `echo ~${podmanUser}`], {
            timeoutMs: 3_000,
          })
        ).stdout.trim();
        const quadletDir = `${homeDir}/.config/containers/systemd`;

        await runExec("sudo", ["-u", podmanUser, "mkdir", "-p", quadletDir], { timeoutMs: 5_000 });

        const quadletContent = [
          "# OpenClaw gateway — Podman Quadlet (rootless)",
          "",
          "[Unit]",
          "Description=OpenClaw gateway (rootless Podman)",
          "",
          "[Container]",
          "Image=openclaw:local",
          "ContainerName=openclaw",
          "UserNS=keep-id",
          `Volume=${homeDir}/.openclaw:/home/node/.openclaw`,
          `EnvironmentFile=${homeDir}/.openclaw/.env`,
          "Environment=HOME=/home/node",
          "Environment=TERM=xterm-256color",
          "PublishPort=18789:18789",
          "PublishPort=18790:18790",
          "Pull=never",
          "Exec=node dist/index.js gateway --bind lan --port 18789",
          "",
          "[Service]",
          "TimeoutStartSec=300",
          "Restart=on-failure",
          "",
          "[Install]",
          "WantedBy=default.target",
          "",
        ].join("\n");

        const quadletPath = `${quadletDir}/openclaw.container`;
        await runExec(
          "sudo",
          [
            "-u",
            podmanUser,
            "bash",
            "-c",
            `cat > '${quadletPath}' <<'QUADLET_EOF'\n${quadletContent}QUADLET_EOF`,
          ],
          { timeoutMs: 5_000 },
        );

        // Reload and enable.
        try {
          await runExec(
            "sudo",
            ["systemctl", `--machine=${podmanUser}@`, "--user", "daemon-reload"],
            { timeoutMs: 10_000 },
          );
          await runExec(
            "sudo",
            ["systemctl", `--machine=${podmanUser}@`, "--user", "enable", "openclaw.service"],
            { timeoutMs: 10_000 },
          );
          runtime.log("Quadlet unit installed and enabled.");
        } catch {
          runtime.log(
            `Quadlet unit written to ${quadletPath}. Reload manually:\n` +
              `  sudo systemctl --machine=${podmanUser}@ --user daemon-reload\n` +
              `  sudo systemctl --machine=${podmanUser}@ --user enable openclaw.service`,
          );
        }
      } catch (err) {
        runtime.error(`Failed to install Quadlet unit: ${String(err)}`);
      }
    } else {
      runtime.log(`\nOn the target Linux host, create the Quadlet unit:`);
      runtime.log(`  mkdir -p ~${podmanUser}/.config/containers/systemd`);
      runtime.log(
        `  Copy your openclaw.container file to ~${podmanUser}/.config/containers/systemd/openclaw.container`,
      );
      runtime.log(`  sudo systemctl --machine=${podmanUser}@ --user daemon-reload`);
      runtime.log(`  sudo systemctl --machine=${podmanUser}@ --user enable openclaw.service`);
    }
  }
}

// --- Main command ---

export async function sandboxBackendCommand(
  opts: SandboxBackendOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const cfg = loadConfig();
  const agentId = opts.agent ? normalizeAgentId(opts.agent) : undefined;
  const sandboxCfg = resolveSandboxConfigForAgent(cfg, agentId);
  const currentBackend = sandboxCfg.backend;

  // JSON mode: just output current backend and exit.
  if (opts.json) {
    runtime.log(JSON.stringify({ backend: currentBackend, agentId: agentId ?? null }, null, 2));
    return;
  }

  // Non-interactive mode: validate and set directly.
  if (opts.set) {
    const requested = opts.set.toLowerCase() as SandboxBackend;
    if (!VALID_BACKENDS.includes(requested)) {
      runtime.error(`Invalid backend "${opts.set}". Valid options: ${VALID_BACKENDS.join(", ")}`);
      runtime.exit(1);
      return;
    }

    if (requested === currentBackend) {
      runtime.log(`Backend is already set to "${currentBackend}".`);
      return;
    }

    const available = await isBackendAvailable(requested);
    if (!available) {
      runtime.log(`Warning: "${requested}" does not appear to be available on this system.`);
    }

    await applyBackend({ cfg, runtime, agentId, backend: requested });
    return;
  }

  // Interactive mode.
  clackIntro(stylePromptTitle("Sandbox backend") ?? "Sandbox backend");

  runtime.log(`Current backend: ${currentBackend}`);

  const selected = await clackSelect({
    message: stylePromptMessage("Select container backend"),
    options: VALID_BACKENDS.map((b) => ({
      value: b,
      label: b === "docker" ? "Docker" : "Podman",
      hint: b === "docker" ? "Docker daemon (default)" : "Podman — daemonless, Linux only",
    })),
    initialValue: currentBackend,
  });

  if (isCancel(selected)) {
    cancel("Cancelled.");
    return;
  }

  if (selected === currentBackend) {
    clackOutro(
      stylePromptTitle(`Backend unchanged (${currentBackend}).`) ??
        `Backend unchanged (${currentBackend}).`,
    );
    return;
  }

  const available = await isBackendAvailable(selected);
  if (!available) {
    runtime.log(`Warning: "${selected}" does not appear to be available on this system.`);
  }

  await applyBackend({ cfg, runtime, agentId, backend: selected });

  // Run Podman host setup when switching to Podman.
  if (selected === "podman") {
    runtime.log("");
    await runPodmanSetup(runtime);
  }

  clackOutro(stylePromptTitle(`Backend set to ${selected}.`) ?? `Backend set to ${selected}.`);
}

async function applyBackend(params: {
  cfg: ReturnType<typeof loadConfig>;
  runtime: RuntimeEnv;
  agentId?: string;
  backend: SandboxBackend;
}): Promise<void> {
  const { cfg, runtime, agentId, backend } = params;
  const nextConfig = structuredClone(cfg) as Record<string, unknown>;

  if (agentId) {
    // Set per-agent backend.
    const agents = (nextConfig.agents ?? {}) as Record<string, unknown>;
    nextConfig.agents = agents;
    const list = (agents.list ?? []) as Array<Record<string, unknown>>;
    agents.list = list;

    let entry = list.find(
      (e) => normalizeAgentId(typeof e.id === "string" ? e.id : "") === agentId,
    );
    if (!entry) {
      entry = { id: agentId };
      list.push(entry);
    }

    const sandbox = (entry.sandbox ?? {}) as Record<string, unknown>;
    entry.sandbox = sandbox;
    sandbox.backend = backend;
  } else {
    // Set global default backend.
    const agents = (nextConfig.agents ?? {}) as Record<string, unknown>;
    nextConfig.agents = agents;
    const defaults = (agents.defaults ?? {}) as Record<string, unknown>;
    agents.defaults = defaults;
    const sandbox = (defaults.sandbox ?? {}) as Record<string, unknown>;
    defaults.sandbox = sandbox;
    sandbox.backend = backend;
  }

  await writeConfigFile(nextConfig as typeof cfg);
  logConfigUpdated(runtime);
}
