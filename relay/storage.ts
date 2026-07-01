// Pluggable blob storage for persisted spoken clips (audio + word timings), so any client
// — web, Electron, future Expo — can replay a past message by asking the always-on relay
// for its bytes instead of caching them per-platform.
//
// Shape mirrors ask-rogo's blob-storage package (put/get/exists/remove, sanitized keys, a
// boot-time factory that selects the backend) but stays plain-Promise — the Effect/Layer
// machinery there would be wildly out of place in this small Deno relay. Adding a GCS or
// Cloudflare R2 backend later is one new class behind this interface + a `case` in the
// factory; no call site changes.

import { AwsClient } from "npm:aws4fetch@1.0.20";

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

// Cloudflare R2 over its S3-compatible API (works from any runtime, incl. Deno Deploy where
// there's no disk). aws4fetch signs the requests; endpoint is <account>.r2.cloudflarestorage.com.
class R2Store implements BlobStore {
  private aws: AwsClient;
  private base: string;
  constructor(accountId: string, accessKeyId: string, secretAccessKey: string, bucket: string) {
    this.aws = new AwsClient({ accessKeyId, secretAccessKey, region: "auto", service: "s3" });
    this.base = `https://${accountId}.r2.cloudflarestorage.com/${bucket}`;
  }
  private req(key: string, init?: RequestInit) { return new Request(`${this.base}/${sanitize(key)}`, init); }
  async put(key: string, data: Uint8Array, contentType?: string) {
    const r = await this.aws.fetch(this.req(key, { method: "PUT", body: data as BodyInit, headers: contentType ? { "content-type": contentType } : undefined }));
    if (!r.ok) throw new Error(`r2 put ${r.status}`);
  }
  async get(key: string): Promise<Uint8Array | null> {
    const r = await this.aws.fetch(this.req(key));
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`r2 get ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  async exists(key: string): Promise<boolean> {
    const r = await this.aws.fetch(this.req(key, { method: "HEAD" }));
    if (r.status === 404) return false;
    if (!r.ok) throw new Error(`r2 head ${r.status}`);
    return true;
  }
  async remove(key: string) {
    const r = await this.aws.fetch(this.req(key, { method: "DELETE" }));
    if (!r.ok && r.status !== 404) throw new Error(`r2 delete ${r.status}`);
  }
}

// Selected once at boot. CLIP_STORE forces a backend; otherwise auto: R2 when its creds are
// present (deploy), else local disk (dev). CLIP_DIR is the local-disk base directory.
export function makeBlobStore(): BlobStore {
  const kind = Deno.env.get("CLIP_STORE") ?? (Deno.env.get("R2_ACCESS_KEY_ID") ? "r2" : "local");
  switch (kind) {
    case "local": return new LocalDiskStore(Deno.env.get("CLIP_DIR") ?? "./clips");
    case "r2": return new R2Store(
      Deno.env.get("R2_ACCOUNT_ID") ?? "",
      Deno.env.get("R2_ACCESS_KEY_ID") ?? "",
      Deno.env.get("R2_SECRET_ACCESS_KEY") ?? "",
      Deno.env.get("R2_BUCKET") ?? "voizecode-clips",
    );
    default: throw new Error(`unknown CLIP_STORE: ${kind}`);
  }
}
