// Vault paths on the wire use "/" and are validated like the desktop app validates them:
// no empty parts, no "." or "..", no drive letters or backslashes, no control characters.

const MAX_PATH_LENGTH = 512;
const PREFIX = "vault/";

/** Returns the bucket key for a vault path, or null if the path is not acceptable. */
export function keyFor(path: string): string | null {
  if (!path || path.length > MAX_PATH_LENGTH) return null;
  if (path.startsWith("/") || path.endsWith("/")) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(path) || /^[a-z]:/i.test(path)) return null;
  for (const part of path.split("/")) {
    if (part === "" || part === "." || part === "..") return null;
  }
  return PREFIX + path;
}

export function pathOf(key: string): string {
  return key.slice(PREFIX.length);
}

export const LIST_PREFIX = PREFIX;
