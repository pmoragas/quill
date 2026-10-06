// Devices authenticate with a bearer token. The Worker stores only SHA-256 hashes of the tokens
// (secret DEVICE_TOKENS = {"<device name>": "<hex sha-256 of its token>"}), so a leaked config
// does not leak working tokens. Removing a device from that map revokes it.

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Returns the device name for a valid token, or null. */
export async function deviceFor(request: Request, devicesJson: string | undefined): Promise<string | null> {
  const header = request.headers.get("Authorization") ?? "";
  const token = /^Bearer (.+)$/.exec(header)?.[1];
  if (!token || !devicesJson) return null;
  let devices: Record<string, string>;
  try {
    devices = JSON.parse(devicesJson);
  } catch {
    return null;
  }
  const hash = await sha256Hex(token);
  let match: string | null = null;
  // Check every device so the time taken does not reveal which one matched.
  for (const [name, expected] of Object.entries(devices)) {
    if (sameString(hash, String(expected).toLowerCase())) match = name;
  }
  return match;
}
