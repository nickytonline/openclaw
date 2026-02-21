import { stopBrowserBridgeServer } from "../../browser/bridge-server.js";
import { loadConfig } from "../../config/config.js";
import { BROWSER_BRIDGES } from "./browser-bridges.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { dockerContainerState, execDocker } from "./docker.js";
import {
  readBrowserRegistry,
  readRegistry,
  removeBrowserRegistryEntry,
  removeRegistryEntry,
  type SandboxBrowserRegistryEntry,
  type SandboxRegistryEntry,
} from "./registry.js";
import { resolveSandboxAgentId } from "./shared.js";

export type SandboxContainerInfo = SandboxRegistryEntry & {
  running: boolean;
  imageMatch: boolean;
};

export type SandboxBrowserInfo = SandboxBrowserRegistryEntry & {
  running: boolean;
  imageMatch: boolean;
};

async function listSandboxRegistryItems<
  TEntry extends { containerName: string; image: string; sessionKey: string },
>(params: {
  read: () => Promise<{ entries: TEntry[] }>;
  resolveEntryConfig: (agentId?: string) => { configuredImage: string; command: string };
}): Promise<Array<TEntry & { running: boolean; imageMatch: boolean }>> {
  const registry = await params.read();
  const results: Array<TEntry & { running: boolean; imageMatch: boolean }> = [];

  for (const entry of registry.entries) {
    const agentId = resolveSandboxAgentId(entry.sessionKey);
    const { configuredImage, command } = params.resolveEntryConfig(agentId);
    const state = await dockerContainerState(entry.containerName, command);
    // Get actual image from container.
    let actualImage = entry.image;
    if (state.exists) {
      try {
        const result = await execDocker(
          ["inspect", "-f", "{{.Config.Image}}", entry.containerName],
          { allowFailure: true, command },
        );
        if (result.code === 0) {
          actualImage = result.stdout.trim();
        }
      } catch {
        // ignore
      }
    }
    results.push({
      ...entry,
      image: actualImage,
      running: state.running,
      imageMatch: actualImage === configuredImage,
    });
  }

  return results;
}

export async function listSandboxContainers(): Promise<SandboxContainerInfo[]> {
  const config = loadConfig();
  return listSandboxRegistryItems<SandboxRegistryEntry>({
    read: readRegistry,
    resolveEntryConfig: (agentId) => {
      const cfg = resolveSandboxConfigForAgent(config, agentId);
      return {
        configuredImage: cfg.docker.image,
        command: cfg.backend === "podman" ? "podman" : "docker",
      };
    },
  });
}

export async function listSandboxBrowsers(): Promise<SandboxBrowserInfo[]> {
  const config = loadConfig();
  return listSandboxRegistryItems<SandboxBrowserRegistryEntry>({
    read: readBrowserRegistry,
    resolveEntryConfig: (agentId) => {
      const cfg = resolveSandboxConfigForAgent(config, agentId);
      return {
        configuredImage: cfg.browser.image,
        command: cfg.backend === "podman" ? "podman" : "docker",
      };
    },
  });
}

export async function removeSandboxContainer(containerName: string): Promise<void> {
  try {
    await execDocker(["rm", "-f", containerName], { allowFailure: true, command: "docker" });
  } catch {
    // ignore removal failures
  }
  try {
    await execDocker(["rm", "-f", containerName], { allowFailure: true, command: "podman" });
  } catch {
    // ignore removal failures
  }
  await removeRegistryEntry(containerName);
}

export async function removeSandboxBrowserContainer(containerName: string): Promise<void> {
  try {
    await execDocker(["rm", "-f", containerName], { allowFailure: true, command: "docker" });
  } catch {
    // ignore removal failures
  }
  try {
    await execDocker(["rm", "-f", containerName], { allowFailure: true, command: "podman" });
  } catch {
    // ignore removal failures
  }
  await removeBrowserRegistryEntry(containerName);

  // Stop browser bridge if active
  for (const [sessionKey, bridge] of BROWSER_BRIDGES.entries()) {
    if (bridge.containerName === containerName) {
      await stopBrowserBridgeServer(bridge.bridge.server).catch(() => undefined);
      BROWSER_BRIDGES.delete(sessionKey);
    }
  }
}
