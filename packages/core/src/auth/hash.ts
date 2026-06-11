import { Algorithm, hash as argonHash, verify as argonVerify } from "@node-rs/argon2";

/**
 * Hash a plaintext password with Argon2id.
 *
 * Argon2id is the recommended variant — it combines Argon2i (side-channel
 * resistance) and Argon2d (GPU-cracking resistance) and is what the
 * Password Hashing Competition winner recommends for new applications.
 *
 * The output is a self-describing PHC-format string that encodes the salt,
 * cost parameters, and algorithm — `verify` only needs the hash, not the
 * parameters separately.
 */
export function hashPassword(password: string): Promise<string> {
  return argonHash(password, { algorithm: Algorithm.Argon2id });
}

/**
 * Constant-time comparison of a plaintext password against an Argon2id hash.
 * Returns false on any error (malformed hash, etc.) — never throws.
 */
export async function verifyPassword(
  passwordHash: string,
  password: string
): Promise<boolean> {
  try {
    return await argonVerify(passwordHash, password);
  } catch {
    return false;
  }
}
