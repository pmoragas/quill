// Creates a token for a new device and prints the hash to put in the DEVICE_TOKENS secret.
//   npm run add-device -- phone
import { createHash, randomBytes } from "node:crypto";

const name = process.argv[2];
if (!name) {
  console.error("Usage: npm run add-device -- <device name>");
  process.exit(1);
}
const token = randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(token).digest("hex");
console.log(`Device:  ${name}`);
console.log(`Token:   ${token}   (give this to the device once; it is not stored anywhere)`);
console.log(`Hash:    ${hash}`);
console.log(`\nAdd to the secret DEVICE_TOKENS, a JSON map of device name to hash, for example:`);
console.log(`  {"${name}": "${hash}"}`);
console.log(`Set it with: npx wrangler secret put DEVICE_TOKENS`);
