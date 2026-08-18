#!/usr/bin/env node
// App Store Connect build status, without pulling in a JWT library.
//
//   node bin/asc-status.mjs            # latest 5 builds + TestFlight processing state
//   node bin/asc-status.mjs --watch    # poll until the newest build stops processing
//
// Why this exists: `eas submit` confirms the *upload*, but Apple's processing state lives only in
// App Store Connect, so "uploaded" and "installable" are minutes apart with nothing in between to
// look at. This closes that gap.
//
// Auth is an ES256 JWT signed with an App Store Connect API key (.p8). Config comes from the
// environment so no secret is committed:
//   ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH (default ~/.appstoreconnect/AuthKey_<ASC_KEY_ID>.p8)
//   ASC_APP_ID (default: the voizecode app record)
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const KEY_ID = process.env.ASC_KEY_ID || "4ZWA52W3L8";
const ISSUER_ID = process.env.ASC_ISSUER_ID || "563bda6c-2225-42ad-9c2b-0631b9d3071f";
const KEY_PATH = process.env.ASC_KEY_PATH || join(homedir(), ".appstoreconnect", `AuthKey_${KEY_ID}.p8`);
const APP_ID = process.env.ASC_APP_ID || "6801661113";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

// ES256 JWT. Apple caps the lifetime at 20 minutes; anything longer is rejected outright.
function token() {
  const key = readFileSync(KEY_PATH, "utf8");
  const header = { alg: "ES256", kid: KEY_ID, typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: ISSUER_ID, iat: now, exp: now + 15 * 60, aud: "appstoreconnect-v1" };
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signer = createSign("SHA256");
  signer.update(body);
  // Apple wants the raw r||s pair, not the DER wrapper Node emits by default.
  const sig = signer.sign({ key, dsaEncoding: "ieee-p1363" });
  return `${body}.${b64url(sig)}`;
}

async function api(path) {
  const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  if (!res.ok) throw new Error(`ASC ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function builds() {
  const q = `/v1/builds?filter[app]=${APP_ID}&sort=-version&limit=5`
    + `&fields[builds]=version,processingState,uploadedDate,expired`;
  const { data } = await api(q);
  return data.map((b) => ({
    build: b.attributes.version,
    state: b.attributes.processingState,   // PROCESSING | VALID | FAILED | INVALID
    uploaded: b.attributes.uploadedDate,
    expired: b.attributes.expired,
  }));
}

const fmt = (b) => `  build ${String(b.build).padEnd(4)} ${String(b.state).padEnd(11)}`
  + `${b.expired ? "(expired) " : ""}${b.uploaded ?? ""}`;

const watch = process.argv.includes("--watch");
try {
  if (!watch) {
    const list = await builds();
    console.log(`App ${APP_ID} — latest builds:`);
    for (const b of list) console.log(fmt(b));
  } else {
    // Poll the newest build only. 30s is well inside Apple's rate limits and processing is
    // measured in minutes, so anything tighter is just noise.
    for (;;) {
      const [newest] = await builds();
      if (!newest) { console.log("no builds yet"); }
      else {
        console.log(`${new Date().toISOString().slice(11, 19)} build ${newest.build}: ${newest.state}`);
        if (newest.state !== "PROCESSING") break;
      }
      await new Promise((r) => setTimeout(r, 30_000));
    }
  }
} catch (err) {
  console.error(String(err.message || err));
  process.exit(1);
}
