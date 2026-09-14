# PROJECT KNOWLEDGE BASE

**Generated:** 2026-09-14

## OVERVIEW

Project: **sgb**

This is a small Node.js web application for extracting structured bank-account data from uploaded DOCX/PDF documents with an OpenAI-compatible LLM, caching each extraction, and generating downloadable DOCX and legacy Word `.doc` files from a DOCX template.

Stack:

- Node.js ESM (`"type": "module"`), intended for modern Node versions; the current environment uses Node `v24.21.0`.
- pnpm `11.x` (`pnpm-lock.yaml` is lockfile version 9).
- Hono `4.6.x` and `@hono/node-server` for the HTTP server.
- `mammoth` for DOCX text extraction, `pdf-parse` for PDF text extraction, and `adm-zip` for direct DOCX XML manipulation.
- `openai` client pointed at a configurable OpenAI-compatible endpoint.
- LibreOffice headless mode for DOCX → legacy DOC conversion, with platform-specific automatic provisioning.
- A plain HTML/CSS/JavaScript frontend in `public/index.html`; there is no frontend framework or bundler.

The application UI and most server messages are in Simplified Chinese.

## STRUCTURE

```text
.
├── AGENTS.md
├── package.json                 # Scripts and runtime dependencies
├── pnpm-lock.yaml               # Locked pnpm dependency graph
├── .env                         # Local configuration/secrets; ignored by git
├── public/
│   └── index.html               # Single-page upload and record-management UI
├── source/
│   └── temp.docx               # Current local DOCX template used by .env
├── src/
│   ├── server.mjs               # Hono routes, startup, configuration, orchestration
│   ├── docx-tool.mjs             # DOCX/PDF parsing, placeholder replacement, font normalization
│   ├── doc-convert.mjs            # Serialized LibreOffice conversion and output validation
│   ├── libreoffice-portable.mjs  # System detection and Linux/macOS provisioning
│   ├── llm-client.mjs             # Prompt, OpenAI-compatible chat request, JSON normalization
│   └── storage.mjs                # Filesystem-backed record and upload persistence
├── lib/
│   ├── README.md                  # LibreOffice provisioning notes (Chinese)
│   └── debs/                      # Tracked Linux x86_64 .deb packages for offline extraction
└── cache/                         # Runtime records and generated files; ignored by git
```

Important boundaries:

- `server.mjs` is the composition root and owns HTTP behavior. Keep parsing, LLM calls, conversion, and storage logic in their respective modules.
- `docx-tool.mjs` operates directly on the DOCX ZIP/XML. It supports uploaded `.docx` and `.pdf`, but does not support legacy `.doc` uploads.
- `storage.mjs` stores one directory per 16-character lowercase hexadecimal record ID. Each record has `meta.json`, an `uploads/` directory, and generated artifacts written lazily during downloads.
- `lib/` contains committed x86_64 Linux LibreOffice packages; unpacked/install directories are ignored. See `lib/README.md` before changing provisioning behavior.

## COMMANDS

Run commands from the repository root.

| Action | Command | Notes |
|--------|---------|-------|
| Install dependencies | `pnpm install` | The repository declares pnpm `^11.5.1`; `npm install` is not the documented package-manager workflow. |
| Start server | `pnpm start` | Runs `node src/server.mjs`, normally at `http://localhost:3000`. |
| Development server | `pnpm dev` | Runs Node's `--watch` mode; no separate asset build is needed. |
| Prepare LibreOffice | `pnpm setup:libreoffice` | Runs `node src/libreoffice-portable.mjs`; may unpack bundled debs or download a platform archive. |
| Test | Not configured | There is currently no test script or test directory. |
| Build | Not configured | The app is unbundled ESM and has no build step. |
| Lint/format | Not configured | No ESLint, Prettier, or equivalent configuration is present. |

For a basic smoke check, start the server and request `/` and `/api/config`. Uploading requires a configured LLM key and a reachable OpenAI-compatible endpoint. DOC/DOCX generation requires a valid template; DOC conversion additionally requires LibreOffice.

## CONFIGURATION

`.env` is loaded automatically through `dotenv/config`. Do not commit it or expose its values. Supported variables include:

- `PORT` — HTTP port; defaults to `3000`.
- `LLM_BASE_URL` or `OPENAI_BASE_URL` — OpenAI-compatible API base URL; defaults to OpenAI's `/v1` endpoint.
- `LLM_API_KEY` or `OPENAI_API_KEY` — required for `/api/upload`.
- `LLM_MODEL` or `OPENAI_MODEL` — model name; defaults to `gpt-4o-mini`.
- `LLM_USER_AGENT` — optional HTTP User-Agent override for gateways/WAFs.
- `TEMPLATE_PATH` — template path, resolved relative to the process working directory when relative. The code default is `templates/default.docx`; the checked-in local `.env` points to `source/temp.docx`.
- `CACHE_DIR` — record storage directory, default `./cache`.
- `LIBREOFFICE_BIN` or `SOFFICE_BIN` — explicit `soffice` executable path.
- `LIBREOFFICE_AUTO_INSTALL` — set to `0`, `false`, or `no` to disable automatic provisioning.
- `LIBREOFFICE_VERSION` and `LIBREOFFICE_MIRROR` — control the LibreOffice download source/version.
- `LIBREOFFICE_LD_LIBRARY_PATH` — extra Linux dynamic-library path.
- `LIBREOFFICE_TIMEOUT_MS` — conversion timeout, default `120000` ms.
- `DOC_FONT_NORMALIZE` — set to `0` to skip DOCX font normalization before DOC conversion.
- `DOC_FONT_FAMILY` — replacement font family, default `Verdana`.

## HTTP API

- `GET /` — serves the frontend.
- `GET /api/config` — returns public runtime capability/configuration status, including model, base URL, API-key presence, template status, LibreOffice status, and recognized field names. It does not return the key itself.
- `POST /api/upload` — accepts multipart form data with one or more `files` fields, parses DOCX/PDF content, sends it to the LLM, and creates a cached record.
- `GET /api/records` — lists cached records newest first.
- `GET /api/records/:id` — returns one record.
- `DELETE /api/records/:id` — deletes a record and its files.
- `GET /api/records/:id/files/:name` — downloads an original uploaded file.
- `GET /api/records/:id/docx` — fills the template and downloads generated DOCX.
- `GET /api/records/:id/doc` — generates a legacy Word `.doc` through LibreOffice.

The six canonical extracted fields are `date`, `accountNumber`, `iban`, `currency`, `recipientName`, and `recipientAddress`. The LLM client whitelists these keys and removes whitespace from account numbers and IBANs after parsing.

## CODING STANDARDS

- **Language:** Modern JavaScript using ESM `.mjs` modules and `async`/`await` for I/O.
- **Style:** Two-space indentation, semicolon-terminated statements, single-quoted strings in server code, trailing commas generally omitted, and concise small helper functions. Existing comments and user-facing messages commonly use Chinese.
- **Modules:** Prefer named exports for reusable module functionality. Keep module responsibilities narrow and avoid adding framework abstractions for this small application.
- **Errors:** Throw descriptive errors in lower-level helpers; HTTP handlers catch expected failures and return `{ error: ... }` JSON with an appropriate status. Existing code uses `try/catch` around optional filesystem/platform operations and deliberately ignores cleanup failures.
- **Security:** Preserve path validation in `storage.mjs`: record IDs must match `/^[a-f0-9]{16}$/`, and upload names are reduced with `path.basename`. Keep secrets in environment variables and never include API keys in logs or responses.
- **DOCX/XML:** Preserve ZIP entries and XML validity. Escape replacement values with `escapeXml`; be careful not to create duplicate XML attributes. Placeholder replacement is paragraph-level because Word may split placeholders across runs.
- **Conversion:** Keep LibreOffice conversions serialized through the existing queue, use the isolated user profile, honor timeout/environment settings, and validate output magic bytes before returning artifacts.
- **Frontend:** The UI is inline vanilla JavaScript. Escape data before interpolating it into HTML with the existing `esc` helper. Preserve the existing API-driven rendering model unless there is a clear need for a frontend build system.
- **Tooling:** There is no configured linter, formatter, test runner, or build system. Follow the existing formatting manually and add tooling only as an explicit project change.

## WHERE TO LOOK

- **Server and routes:** `src/server.mjs`
- **Document parsing/template generation:** `src/docx-tool.mjs`
- **LLM contract and extraction prompt:** `src/llm-client.mjs`
- **Record persistence and path safety:** `src/storage.mjs`
- **DOC/DOCX conversion:** `src/doc-convert.mjs`
- **LibreOffice discovery/provisioning:** `src/libreoffice-portable.mjs` and `lib/README.md`
- **Browser UI:** `public/index.html`
- **Template:** `source/temp.docx` in the checked-in working tree; deployments can override via `TEMPLATE_PATH`
- **Runtime data:** `cache/` (ignored; do not treat generated records as source files)
- **Dependencies/scripts:** `package.json` and `pnpm-lock.yaml`

## NOTES

- Startup does not block while LibreOffice is auto-installed. `/api/config` may initially report conversion unavailable and later report it as ready after the background provisioning promise completes.
- The bundled `lib/debs` packages are Linux x86_64-specific. Other supported platforms/architectures use a system installation or download the appropriate archive. Provisioning relies on platform tools such as `dpkg-deb`/`tar` on Linux and `hdiutil`/`ditto`/`xattr` on macOS.
- The current repository has no `templates/` directory. Without the local `.env` (or an explicit `TEMPLATE_PATH`), the code's default template path is missing and generated document endpoints will fail.
- The current `source/temp.docx` archive contains a `{{$Date}}` placeholder according to the template inspection. If the six extracted fields should appear in generated documents, add matching placeholders to the template using the exact `{{$Field}}` convention (case-insensitive field lookup).
- Uploaded source files and generated artifacts can contain sensitive banking information. Treat `cache/`, logs, downloaded documents, and any API payloads as confidential; do not commit or paste them into issue reports.
- There is no automated test coverage. When modifying XML manipulation, storage paths, conversion, or the LLM response contract, perform a manual end-to-end smoke test and inspect generated files with the relevant office tool.
- No additional repository context files such as `CLAUDE.md` or `.cursorrules` were found during initialization.
