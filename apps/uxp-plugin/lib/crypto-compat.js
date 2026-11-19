"use strict";

// UXP has secure random values, but does not guarantee SubtleCrypto,
// TextEncoder, or btoa. Keep the wire algorithms unchanged using CryptoJS 4.2.0.
const CryptoJS = require("./vendor/crypto-js/core");
require("./vendor/crypto-js/enc-base64");
const hmacSHA256 = require("./vendor/crypto-js/hmac-sha256");
const sha256 = require("./vendor/crypto-js/sha256");

function wordArray(value) {
  if (typeof value === "string") return CryptoJS.enc.Utf8.parse(value);
  if (!ArrayBuffer.isView(value) && Object.prototype.toString.call(value) !== "[object ArrayBuffer]") throw new TypeError("Expected a string, ArrayBuffer or typed-array view");
  const bytes = ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
  const words = [];
  for (let i = 0; i < bytes.length; i += 1) {
    words[i >>> 2] = (words[i >>> 2] || 0) | (bytes[i] << (24 - (i % 4) * 8));
  }
  return CryptoJS.lib.WordArray.create(words, bytes.length);
}

function base64(value) { return wordArray(value).toString(CryptoJS.enc.Base64); }
function base64url(value) { return base64(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
function hmacSha256Base64url(value, key) {
  return hmacSHA256(value, key).toString(CryptoJS.enc.Base64).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function sha256Hex(value) { return sha256(wordArray(value)).toString(); }
function utf8ByteLength(value) { return CryptoJS.enc.Utf8.parse(value).sigBytes; }

module.exports = { base64, base64url, hmacSha256Base64url, sha256Hex, utf8ByteLength };
