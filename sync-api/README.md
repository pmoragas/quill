# Quill sync API

A small Cloudflare Worker in front of an R2 bucket. Quill devices (desktop, Android) sync the vault through it. See [../docs/SYNC-SPEC.md](../docs/SYNC-SPEC.md).

## Endpoints

All except `/health` need `Authorization: Bearer <device token>`.

| Request | Meaning |
|---|---|
| `GET /health` | `{"ok":true}` |
| `GET /v1/files?cursor=` | One page of `{path, etag, size, uploaded}`; `cursor` present when more follow |
| `GET /v1/files/<path>` | The file; the `ETag` header carries its version |
| `HEAD /v1/files/<path>` | Version only |
| `PUT /v1/files/<path>` | Needs `If-Match: <version>` (replace) or `If-None-Match: *` (create). `200 {etag}`; `412` if the file changed meanwhile; `428` if neither header is sent |
| `DELETE /v1/files/<path>` | Needs `If-Match: <version>`. `412` if the file changed meanwhile |

Files over 20 MB are refused (413). Paths are checked like the desktop app checks them (no `..`, no absolute paths, no backslashes).

## Develop

```sh
npm install
npm test          # emulated R2, no Cloudflare account needed
npm run typecheck
```

To run it locally, put a device in `.dev.vars` (see `npm run add-device`) and run `npm run dev`. Then: `SYNC_URL=http://localhost:8787 SYNC_TOKEN=<token> npm run smoke`.

## Deploy (needs a Cloudflare account)

```sh
npx wrangler login
npx wrangler r2 bucket create quill-vault
npm run add-device -- desktop           # prints a token and its hash
npx wrangler secret put DEVICE_TOKENS   # paste {"desktop": "<hash>"}
npm run deploy
SYNC_URL=https://quill-sync.<you>.workers.dev SYNC_TOKEN=<token> npm run smoke
```

The smoke test confirms that the real R2 enforces the version checks. To revoke a device, remove it from `DEVICE_TOKENS` and set the secret again.
