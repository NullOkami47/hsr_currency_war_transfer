import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DEFAULT_STEP_SECONDS = 30;
const DEFAULT_DIGITS = 6;

export function encodeTotpSecret(value) {
  const bytes = Buffer.from(value);
  if (bytes.length < 20) {
    throw new TypeError("TOTP secret must contain at least 20 bytes");
  }
  let buffer = 0;
  let bufferedBits = 0;
  let encoded = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bufferedBits += 8;
    while (bufferedBits >= 5) {
      bufferedBits -= 5;
      encoded += BASE32_ALPHABET[(buffer >>> bufferedBits) & 0x1f];
      buffer &= (1 << bufferedBits) - 1;
    }
  }
  if (bufferedBits > 0) {
    encoded += BASE32_ALPHABET[(buffer << (5 - bufferedBits)) & 0x1f];
  }
  return encoded;
}

export function generateTotpSecret({ byteLength = 20, randomBytesFn = randomBytes } = {}) {
  if (!Number.isInteger(byteLength) || byteLength < 20 || byteLength > 64) {
    throw new TypeError("TOTP secret byte length is invalid");
  }
  return encodeTotpSecret(randomBytesFn(byteLength));
}

export function decodeTotpSecret(secret) {
  const encoded = String(secret ?? "")
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/=+$/, "");
  if (!encoded || encoded.length > 256 || !/^[A-Z2-7]+$/.test(encoded)) {
    throw new TypeError("TOTP secret must be valid Base32");
  }

  const bytes = [];
  let buffer = 0;
  let bufferedBits = 0;
  for (const character of encoded) {
    buffer = (buffer << 5) | BASE32_ALPHABET.indexOf(character);
    bufferedBits += 5;
    if (bufferedBits >= 8) {
      bufferedBits -= 8;
      bytes.push((buffer >>> bufferedBits) & 0xff);
      buffer &= (1 << bufferedBits) - 1;
    }
  }

  const decoded = Buffer.from(bytes);
  if (decoded.length < 20) {
    throw new TypeError("TOTP secret must decode to at least 20 bytes");
  }
  return decoded;
}

function totpForCounter(secret, counter, digits) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const digest = createHmac("sha1", secret).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  ) >>> 0;
  return String(binary % (10 ** digits)).padStart(digits, "0");
}

function timeCounter(now, stepSeconds) {
  const timestamp = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(timestamp)) throw new TypeError("TOTP time is invalid");
  return BigInt(Math.floor(timestamp / 1000 / stepSeconds));
}

export function totpCode(secret, {
  now = new Date(),
  stepSeconds = DEFAULT_STEP_SECONDS,
  digits = DEFAULT_DIGITS,
} = {}) {
  if (!Number.isInteger(stepSeconds) || stepSeconds < 1 || stepSeconds > 300) {
    throw new TypeError("TOTP time step is invalid");
  }
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
    throw new TypeError("TOTP digit count is invalid");
  }
  return totpForCounter(
    decodeTotpSecret(secret),
    timeCounter(now, stepSeconds),
    digits,
  );
}

export function verifyTotpCode(secret, supplied, {
  now = new Date(),
  stepSeconds = DEFAULT_STEP_SECONDS,
  digits = DEFAULT_DIGITS,
  window = 1,
} = {}) {
  const code = String(supplied ?? "");
  if (!new RegExp(`^\\d{${digits}}$`).test(code)) return false;
  if (!Number.isInteger(window) || window < 0 || window > 2) {
    throw new TypeError("TOTP verification window is invalid");
  }
  const decoded = decodeTotpSecret(secret);
  const counter = timeCounter(now, stepSeconds);
  const suppliedBytes = Buffer.from(code);
  let matched = 0;
  for (let offset = -window; offset <= window; offset += 1) {
    const candidateCounter = counter + BigInt(offset);
    if (candidateCounter < 0n) continue;
    const candidate = Buffer.from(
      totpForCounter(decoded, candidateCounter, digits),
    );
    matched |= Number(timingSafeEqual(candidate, suppliedBytes));
  }
  return matched === 1;
}
