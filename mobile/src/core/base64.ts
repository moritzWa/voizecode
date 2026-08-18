// Base64 <-> bytes. The web client uses atob/btoa with a char-by-char loop; Hermes has both,
// but the mic path encodes a 4096-frame PCM buffer several times a second and the naive
// String.fromCharCode loop shows up in a profile. These do it in one pass over a lookup table.

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = new Uint8Array(256);
for (let i = 0; i < ALPHA.length; i++) LOOKUP[ALPHA.charCodeAt(i)] = i;

export function bytesToB64(bytes: Uint8Array): string {
  let out = "";
  const n = bytes.length;
  const tail = n % 3;
  const end = n - tail;
  for (let i = 0; i < end; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHA[(v >> 18) & 63] + ALPHA[(v >> 12) & 63] + ALPHA[(v >> 6) & 63] + ALPHA[v & 63];
  }
  if (tail === 1) {
    const v = bytes[end];
    out += ALPHA[v >> 2] + ALPHA[(v << 4) & 63] + "==";
  } else if (tail === 2) {
    const v = (bytes[end] << 8) | bytes[end + 1];
    out += ALPHA[v >> 10] + ALPHA[(v >> 4) & 63] + ALPHA[(v << 2) & 63] + "=";
  }
  return out;
}

export function b64ToBytes(b64: string): Uint8Array {
  let len = b64.length;
  while (len > 0 && b64[len - 1] === "=") len--;
  const out = new Uint8Array((len * 3) >> 2);
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const a = LOOKUP[b64.charCodeAt(i)];
    const b = LOOKUP[b64.charCodeAt(i + 1)];
    const c = LOOKUP[b64.charCodeAt(i + 2)];
    const d = LOOKUP[b64.charCodeAt(i + 3)];
    out[o++] = (a << 2) | (b >> 4);
    if (i + 2 < len) out[o++] = ((b & 15) << 4) | (c >> 2);
    if (i + 3 < len) out[o++] = ((c & 3) << 6) | d;
  }
  return out;
}

// Float samples (-1..1, what AudioRecorder hands us) -> base64 linear16, which is the encoding
// the relay hands straight to Deepgram. Asymmetric clamp: 32768 negative, 32767 positive.
// ArrayBufferLike, not ArrayBuffer: the samples come straight off a native AudioBuffer, whose
// backing store TS can't prove isn't shared. We only read from it.
export function floatsToPcmB64(samples: Float32Array<ArrayBufferLike>): string {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = x < 0 ? x * 0x8000 : x * 0x7fff;
  }
  return bytesToB64(new Uint8Array(pcm.buffer));
}
