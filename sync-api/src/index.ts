import { deviceFor } from "./auth";
import { keyFor, LIST_PREFIX, pathOf } from "./paths";

export interface Env {
  BUCKET: R2Bucket;
  /** JSON map of device name to the SHA-256 hex of its token. */
  DEVICE_TOKENS?: string;
  /** Largest file accepted, in bytes. */
  MAX_FILE_BYTES?: string;
}

const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
const LIST_PAGE = 500;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

const fail = (status: number, error: string, message: string) => json({ error, message }, status);

/** ETag header value -> bare tag, so it can be compared with the object's etag. */
function bareTag(value: string): string {
  return value.replace(/^W\//, "").replace(/^"|"$/g, "");
}

async function listFiles(request: Request, env: Env): Promise<Response> {
  const cursor = new URL(request.url).searchParams.get("cursor") ?? undefined;
  const page = await env.BUCKET.list({ prefix: LIST_PREFIX, cursor, limit: LIST_PAGE });
  return json({
    files: page.objects.map((o) => ({ path: pathOf(o.key), etag: o.etag, size: o.size, uploaded: o.uploaded.toISOString() })),
    cursor: page.truncated ? page.cursor : undefined,
  });
}

async function readFile(key: string, env: Env, head: boolean): Promise<Response> {
  const object = head ? await env.BUCKET.head(key) : await env.BUCKET.get(key);
  if (!object) return fail(404, "not_found", "No such file.");
  const headers = new Headers({ ETag: object.httpEtag, "Cache-Control": "no-store", "Content-Length": String(object.size) });
  headers.set("Content-Type", object.httpMetadata?.contentType ?? "application/octet-stream");
  return new Response(head ? null : (object as R2ObjectBody).body, { headers });
}

async function writeFile(request: Request, key: string, env: Env): Promise<Response> {
  const ifMatch = request.headers.get("If-Match");
  const ifNoneMatch = request.headers.get("If-None-Match");
  // A write must say what it expects to replace, so a device can never overwrite blindly.
  if (!ifMatch && ifNoneMatch !== "*") {
    return fail(428, "precondition_required", "Send If-Match with the version you last saw, or If-None-Match: * for a new file.");
  }
  const limit = Number(env.MAX_FILE_BYTES) || DEFAULT_MAX_FILE_BYTES;
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > limit) return fail(413, "too_large", `Files are limited to ${limit} bytes.`);
  const body = await request.arrayBuffer();
  if (body.byteLength > limit) return fail(413, "too_large", `Files are limited to ${limit} bytes.`);

  const onlyIf = ifMatch ? { etagMatches: bareTag(ifMatch) } : new Headers({ "If-None-Match": "*" });
  const stored = await env.BUCKET.put(key, body, {
    onlyIf,
    httpMetadata: { contentType: request.headers.get("Content-Type") ?? "application/octet-stream" },
  });
  // R2 returns null when the condition fails: someone else changed the file first.
  if (!stored) return fail(412, "conflict", "The file changed since you last saw it.");
  return json({ etag: stored.etag, size: stored.size }, 200, { ETag: stored.httpEtag });
}

async function deleteFile(request: Request, key: string, env: Env): Promise<Response> {
  const ifMatch = request.headers.get("If-Match");
  if (!ifMatch) return fail(428, "precondition_required", "Send If-Match with the version you last saw.");
  const current = await env.BUCKET.head(key);
  if (!current) return json({ deleted: false });
  // R2 has no conditional delete, so this check and the delete are two steps. A write landing
  // between them is possible but needs two devices acting within milliseconds.
  if (current.etag !== bareTag(ifMatch)) return fail(412, "conflict", "The file changed since you last saw it.");
  await env.BUCKET.delete(key);
  return json({ deleted: true });
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") return json({ ok: true });

  if (!(await deviceFor(request, env.DEVICE_TOKENS))) {
    return fail(401, "unauthorized", "Missing or revoked device token.");
  }

  if (url.pathname === "/v1/files" && request.method === "GET") return listFiles(request, env);

  const match = /^\/v1\/files\/(.+)$/.exec(url.pathname);
  if (!match) return fail(404, "not_found", "Unknown endpoint.");
  let path: string;
  try {
    path = decodeURIComponent(match[1]);
  } catch {
    return fail(400, "bad_path", "The path is not valid.");
  }
  const key = keyFor(path);
  if (!key) return fail(400, "bad_path", "The path is not valid.");

  switch (request.method) {
    case "GET":
      return readFile(key, env, false);
    case "HEAD":
      return readFile(key, env, true);
    case "PUT":
      return writeFile(request, key, env);
    case "DELETE":
      return deleteFile(request, key, env);
    default:
      return fail(405, "method_not_allowed", "Use GET, HEAD, PUT or DELETE.");
  }
}

export default { fetch: handle } satisfies ExportedHandler<Env>;
