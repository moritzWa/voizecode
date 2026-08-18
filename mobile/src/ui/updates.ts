// expo-updates, but safe to import from a build that doesn't have the native module.
//
// A top-level `import * as Updates from "expo-updates"` throws "Cannot find native module
// 'ExpoUpdates'" at module load — which crashes the whole app, not just the feature. That is
// exactly what happens to any build made before the package was added (the dev build on this
// machine, and any older TestFlight build), and a JS-only OTA cannot add a native module. So the
// import is lazy and guarded: on a build without it, every call is simply a no-op.
type UpdatesModule = typeof import("expo-updates");

let mod: UpdatesModule | null | undefined; // undefined = not tried yet, null = unavailable
function updates(): UpdatesModule | null {
  if (mod === undefined) {
    try { mod = require("expo-updates") as UpdatesModule; }
    catch { mod = null; }
    // Present as a JS package but without the native side: reading a property throws.
    if (mod) { try { void mod.updateId; } catch { mod = null; } }
  }
  return mod;
}

export function updateInfo(): { runtime: string; id: string; createdAt: string } {
  const u = updates();
  if (!u) return { runtime: "?", id: "development build", createdAt: "" };
  try {
    return {
      runtime: u.runtimeVersion ?? "?",
      id: u.updateId ?? "embedded bundle",
      createdAt: u.createdAt ? new Date(u.createdAt).toLocaleString() : "",
    };
  } catch {
    return { runtime: "?", id: "development build", createdAt: "" };
  }
}

// Fetch and apply a pending update at cold start. expo-updates otherwise applies on the *next*
// launch, so one relaunch after publishing still runs the old bundle — indistinguishable from
// "the update never shipped".
export async function applyPendingUpdate(): Promise<void> {
  if (__DEV__) return; // dev builds load from Metro; there is nothing to fetch
  const u = updates();
  if (!u) return;
  try {
    const check = await u.checkForUpdateAsync();
    if (!check.isAvailable) return;
    await u.fetchUpdateAsync();
    await u.reloadAsync();
  } catch { /* offline, or already current — keep running what we have */ }
}
