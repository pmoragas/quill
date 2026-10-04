// Vault-relative paths always use "/" separators.

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Resolves `rel` against `dir`; returns null if the result escapes the vault. */
export function joinInVault(dir: string, rel: string): string | null {
  if (rel.startsWith("/") || /^[a-z]:/i.test(rel)) return null;
  const parts = dir ? dir.split("/") : [];
  for (const part of rel.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.length ? parts.join("/") : null;
}

/** Path to `target` as seen from the folder `fromDir` (both vault-relative). */
export function relativeTo(fromDir: string, target: string): string {
  const from = fromDir ? fromDir.split("/") : [];
  const to = target.split("/");
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  return [...Array(from.length - common).fill(".."), ...to.slice(common)].join("/");
}
