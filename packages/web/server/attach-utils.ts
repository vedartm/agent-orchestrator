import {
  createPluginRegistry,
  createSessionManager,
  loadConfig,
  type AttachInfo,
  type OpenCodeSessionManager,
} from "@composio/ao-core";

let sessionManagerPromise: Promise<OpenCodeSessionManager> | null = null;

async function getSessionManager(): Promise<OpenCodeSessionManager> {
  if (!sessionManagerPromise) {
    sessionManagerPromise = (async () => {
      const config = loadConfig();
      const registry = createPluginRegistry();
      await registry.loadFromConfig(config, (pkg: string) => import(pkg));
      return createSessionManager({ config, registry });
    })();
  }
  return sessionManagerPromise;
}

export async function resolveAttachInfo(sessionId: string): Promise<AttachInfo | null> {
  const sessionManager = await getSessionManager();
  return sessionManager.getAttachInfo(sessionId);
}
