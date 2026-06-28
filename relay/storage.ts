// Pluggable blob storage for persisted spoken clips (audio + word timings), so any client
// — web, Electron, future Expo — can replay a past message by asking the always-on relay
// for its bytes instead of caching them per-platform.
//
// Shape mirrors ask-rogo's blob-storage package (put/get/exists/remove, sanitized keys, a
// boot-time factory that selects the backend) but stays plain-Promise — the Effect/Layer
// machinery there would be wildly out of place in this small Deno relay. Adding a GCS or
// Cloudflare R2 backend later is one new class behind this interface + a `case` in the
// factory; no call site changes.

export interface BlobStore {
  put(key: string, data: Uint8Array, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  exists(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
}

// Strip leading slashes and any "."/".." segments so a key can never escape the base dir
// (path-traversal guard, same intent as ask-rogo's sanitizeSegment).
function sanitize(key: string): string {
  return key.replace(/^\/+/, "").split("/").filter((s) => s && s !== "." && s !== "..").join("/");
}

class LocalDiskStore implements BlobStore {
  constructor(private baseDir: string) {}
  private path(key: string) { return `${this.baseDir}/${sanitize(key)}`; }

  async put(key: string, data: Uint8Array) {
    const p = this.path(key);
    const dir = p.slice(0, p.lastIndexOf("/"));
    if (dir) await Deno.mkdir(dir, { recursive: true });
    await Deno.writeFile(p, data);
  }
  async get(key: string): Promise<Uint8Array | null> {
    try { return await Deno.readFile(this.path(key)); }
    catch (e) { if (e instanceof Deno.errors.NotFound) return null; throw e; }
  }
  async exists(key: string): Promise<boolean> {
    try { await Deno.stat(this.path(key)); return true; }
    catch (e) { if (e instanceof Deno.errors.NotFound) return false; throw e; }
  }
  async remove(key: string) {
    try { await Deno.remove(this.path(key)); }
    catch (e) { if (!(e instanceof Deno.errors.NotFound)) throw e; }
  }
}

// Selected once at boot. CLIP_STORE picks the backend (only "local" today); CLIP_DIR is the
// local-disk base directory. A future "gcs"/"r2" case constructs its own BlobStore here.
export function makeBlobStore(): BlobStore {
  const kind = Deno.env.get("CLIP_STORE") ?? "local";
  switch (kind) {
    case "local": return new LocalDiskStore(Deno.env.get("CLIP_DIR") ?? "./clips");
    default: throw new Error(`unknown CLIP_STORE: ${kind}`);
  }
}
