// End-to-end check of a running sync API, including R2's version checks.
//   SYNC_URL=https://quill-sync.<you>.workers.dev SYNC_TOKEN=<device token> npm run smoke
// It only touches files under "_smoke/" and removes them afterwards.
const base = (process.env.SYNC_URL ?? "").replace(/\/$/, "");
const token = process.env.SYNC_TOKEN;
if (!base || !token) {
  console.error("Set SYNC_URL and SYNC_TOKEN.");
  process.exit(1);
}

const call = (method, path, init = {}) =>
  fetch(`${base}/v1/files/${path}`, { method, ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (${detail})`}`);
  if (!ok) failed++;
};

const path = `_smoke/${Date.now()}.md`;

const health = await fetch(`${base}/health`);
check("health answers", health.ok, health.status);

const unauth = await fetch(`${base}/v1/files`);
check("requests without a token are refused", unauth.status === 401, unauth.status);

const created = await call("PUT", path, { body: "one", headers: { "If-None-Match": "*" } });
const { etag } = created.ok ? await created.json() : {};
check("a new file is created", created.status === 200 && !!etag, created.status);

const again = await call("PUT", path, { body: "two", headers: { "If-None-Match": "*" } });
check("creating the same file again is refused (412)", again.status === 412, again.status);

const blind = await call("PUT", path, { body: "blind" });
check("a write without a version is refused (428)", blind.status === 428, blind.status);

const updated = await call("PUT", path, { body: "three", headers: { "If-Match": etag } });
const next = updated.ok ? (await updated.json()).etag : undefined;
check("a write with the current version succeeds", updated.status === 200 && next && next !== etag, updated.status);

const stale = await call("PUT", path, { body: "stale", headers: { "If-Match": etag } });
check("a write with an old version is refused (412)", stale.status === 412, stale.status);

const read = await call("GET", path);
check("the stored content is the last accepted write", (await read.text()) === "three");

const listed = await (await fetch(`${base}/v1/files`, { headers: { Authorization: `Bearer ${token}` } })).json();
check("the file appears in the listing", listed.files.some((f) => f.path === path));

const staleDelete = await call("DELETE", path, { headers: { "If-Match": etag } });
check("deleting with an old version is refused (412)", staleDelete.status === 412, staleDelete.status);

const deleted = await call("DELETE", path, { headers: { "If-Match": next } });
check("deleting with the current version succeeds", deleted.ok && (await deleted.json()).deleted === true);

console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
