/**
 * crypto.js — Browser-native AES-256-GCM encryption via Web Crypto API
 * Zero external dependencies. Passphrase never persisted.
 */

const Crypto = (() => {
  /* eslint-disable -- keeping original structure */
  const PBKDF2_ITERATIONS = 310_000;
  const SALT_LENGTH = 16;    // bytes
  const IV_LENGTH = 12;      // bytes (recommended for GCM)
  const ALGO = 'AES-GCM';

  /** Convert string to Uint8Array */
  function encode(str) {
    return new TextEncoder().encode(str);
  }

  /** Convert Uint8Array to string */
  function decode(buf) {
    return new TextDecoder().decode(buf);
  }

  /** Convert ArrayBuffer to base64 string */
  function bufToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /** Convert base64 string to Uint8Array */
  function base64ToBuf(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /** Generate random bytes */
  function randomBytes(length) {
    return crypto.getRandomValues(new Uint8Array(length));
  }

  /**
   * Derive an AES-256-GCM CryptoKey from a passphrase + salt
   * @param {string} passphrase
   * @param {Uint8Array} salt
   * @returns {Promise<CryptoKey>}
   */
  async function deriveKey(passphrase, salt) {
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey']
    );

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256',
      },
      keyMaterial,
      { name: ALGO, length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Encrypt plaintext with a passphrase.
   * Returns a base64 string containing salt + iv + ciphertext.
   * @param {string} passphrase
   * @param {string} plaintext
   * @returns {Promise<string>} base64-encoded blob
   */
  async function encrypt(passphrase, plaintext) {
    const salt = randomBytes(SALT_LENGTH);
    const iv = randomBytes(IV_LENGTH);
    const key = await deriveKey(passphrase, salt);

    const ciphertext = await crypto.subtle.encrypt(
      { name: ALGO, iv },
      key,
      encode(plaintext)
    );

    // Pack: salt(16) + iv(12) + ciphertext(variable)
    const packed = new Uint8Array(
      SALT_LENGTH + IV_LENGTH + ciphertext.byteLength
    );
    packed.set(salt, 0);
    packed.set(iv, SALT_LENGTH);
    packed.set(new Uint8Array(ciphertext), SALT_LENGTH + IV_LENGTH);

    return bufToBase64(packed);
  }

  /**
   * Decrypt a base64 blob with a passphrase.
   * @param {string} passphrase
   * @param {string} blob base64-encoded
   * @returns {Promise<string>} plaintext
   * @throws {Error} if passphrase is wrong or data is corrupt
   */
  async function decrypt(passphrase, blob) {
    const packed = base64ToBuf(blob);

    const salt = packed.slice(0, SALT_LENGTH);
    const iv = packed.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const ciphertext = packed.slice(SALT_LENGTH + IV_LENGTH);

    const key = await deriveKey(passphrase, salt);

    try {
      const plainBuf = await crypto.subtle.decrypt(
        { name: ALGO, iv },
        key,
        ciphertext
      );
      return decode(plainBuf);
    } catch {
      throw new Error('Decryption failed — wrong passphrase or corrupted data');
    }
  }

  /**
   * Quick hash for fingerprinting (not for security).
   * Returns hex string of SHA-256.
   */
  async function sha256(text) {
    const hash = await crypto.subtle.digest('SHA-256', encode(text));
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  return { encrypt, decrypt, sha256 };
})();

export default Crypto;
