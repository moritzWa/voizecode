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

// Coalesced writes for values that change far faster than they need to be durable.
//
// The transcript was serialized on every single change — every sentence of a reply, over up to
// 300 lines per session times every open tab — with JSON.stringify running synchronously on the
// JS thread, at the same moment audio is decoding and the reply is streaming in. On a resumed
// session that is hundreds of KB restringified per sentence, and it lands squarely on the frames
// that were already the tightest.
//
// Writes are fire-and-forget anyway (see the header): losing the last second of transcript to a
// crash was already accepted, so deferring it costs nothing we were not already prepared to lose.
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const latest = new Map<string, unknown>();

export function setJSONSoon(key: string, value: unknown, ms = 800): void {
  latest.set(key, value);
  if (timers.has(key)) return; // a write is already scheduled; it will pick up the newest value
  timers.set(key, setTimeout(() => { timers.delete(key); flushJSON(key); }, ms));
}

// Write a pending value now — on teardown, or when the app is about to go to the background and
// may not get another timer tick.
export function flushJSON(key?: string): void {
  for (const k of key ? [key] : [...latest.keys()]) {
    const t = timers.get(k);
    if (t) { clearTimeout(t); timers.delete(k); }
    if (latest.has(k)) { setJSON(k, latest.get(k)); latest.delete(k); }
  }
}

export function setJSON(key: string, value: unknown): void {
  try { set(key, JSON.stringify(value)); } catch { /* cyclic; caller's problem */ }
}

export function remove(key: string): void {
  cache.delete(key);
  void AsyncStorage.removeItem(key).catch(() => { /* noop */ });
}
