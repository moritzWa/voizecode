// AsyncStorage stands in for the web client's localStorage. The important difference is that
// it's async, so anything the hook needs synchronously at first render (the access token, the
// saved transcripts) is hydrated once at startup into an in-memory cache and read from there.
// Writes are fire-and-forget; losing the last transcript write to a crash is not worth awaiting.
import AsyncStorage from "@react-native-async-storage/async-storage";

export const KEYS = {
  token: "voize:token",
  convos: "voize:convos:v1",
  tabs: "voize:tabs:v1",
  active: "voize:activeTab",
  voice: "voize:voice",
  rate: "voize:rate",
  thinkingSound: "voize:thinkingSound",
} as const;

const cache = new Map<string, string>();

export async function hydrate(): Promise<void> {
  const entries = await AsyncStorage.multiGet(Object.values(KEYS));
  for (const [k, v] of entries) if (v != null) cache.set(k, v);
}

export function get(key: string): string | null {
  return cache.get(key) ?? null;
}

export function getJSON<T>(key: string, fallback: T): T {
  const raw = cache.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export function set(key: string, value: string): void {
  cache.set(key, value);
  void AsyncStorage.setItem(key, value).catch(() => { /* full disk; nothing useful to do */ });
}

export function setJSON(key: string, value: unknown): void {
  try { set(key, JSON.stringify(value)); } catch { /* cyclic; caller's problem */ }
}

export function remove(key: string): void {
  cache.delete(key);
  void AsyncStorage.removeItem(key).catch(() => { /* noop */ });
}
