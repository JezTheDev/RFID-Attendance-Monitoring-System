// Crypto adapter for the Apps Script server (see passwords.js for the shape).
// Utilities works with Java bytes (-128..127), so bytes are converted to signed first.
/* global Utilities */

function toSigned(bytes) {
  return Array.from(bytes, (b) => {
    const unsigned = b & 0xff;
    return unsigned > 127 ? unsigned - 256 : unsigned;
  });
}

export function appsScriptCrypto() {
  return {
    sha256: (bytes) => Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, toSigned(bytes)),
    utf8: (text) => Utilities.newBlob(String(text)).getBytes(),
    // Apps Script has no crypto RNG API; getUuid() is a random (v4) UUID.
    // Hex digits 12 (version "4") and 16 (variant 8-b) are not random: drop them.
    randomHex: (byteCount) => {
      let hex = '';
      while (hex.length < byteCount * 2) {
        const uuid = Utilities.getUuid().replace(/-/g, '');
        hex += uuid.slice(0, 12) + uuid.slice(13, 16) + uuid.slice(17);
      }
      return hex.slice(0, byteCount * 2);
    },
  };
}
