# 0003 — `pdfjs-dist` and `@napi-rs/canvas` for the PDF input paths

**Status** — accepted 2026-07-29 · **Milestone** — M2a commit 3

## Context

M2a needs two things from a PDF, and the repository had neither: read the text layer of a
born-digital document, and rasterise the pages of a scanned one so the vision path has pixels. Nothing
was installed — `pdfjs-dist`, `unpdf`, `pdf-parse`, `pdf-lib`, `@hyzyla/pdfium`, `canvas`,
`@napi-rs/canvas` and `tesseract.js` were all verified absent before this decision.

Deferring was considered and rejected. `lib/storage/index.ts` deferred the R2 adapter on the grounds
that *"it cannot be executed without credentials, and an unverified adapter would be code nobody has run
pretending to be integration."* That reasoning does not transfer: a PDF renderer **can** be exercised
locally, so shipping only a port with no implementation would be the weaker choice, not the disciplined
one.

## Decision

| Package | Version | Purpose | Licence |
|---|---|---|---|
| `pdfjs-dist` | `^6.2.108` | Text-layer extraction, page count, text-layer detection | Apache-2.0 |
| `@napi-rs/canvas` | `^1.0.3` | Rasterising pages to PNG | MIT |

Both are confined to `lib/extract/input/`. `pdfjs-dist` appears in `pdf.ts` and `render.ts`;
`@napi-rs/canvas` appears only in `render.ts`. **A test asserts that no other file in the repository
imports either**, and a second asserts the domain contains no PDF vocabulary at all.

The parser port (`lib/extract/port.ts`) is provider-neutral by construction: a layout parser written in
M2b sees `ExtractedDocument` and `PageText`, never a pdf.js type.

## Diligence performed (2026-07-29)

- **Transitive surface is effectively nil.** `pdfjs-dist` declares **no `dependencies` at all**.
  `@napi-rs/canvas` declares none either — only 11 `optionalDependencies`, one prebuilt binary per
  platform, including `win32-x64-msvc` (this machine) and `linux-x64-gnu` / `linux-x64-musl` (likely
  deployment targets). **No compiler is required at install time.**
- **Install cost:** 3 packages total. `npm audit` reports **0 vulnerabilities**.
- **Maintenance:** both published 2026-07-28, the day before this decision. pdf.js is Mozilla's, with
  monthly releases.
- **Verified locally on Node 24.16.0**, not assumed: text extracted verbatim from a generated
  born-digital PDF; a page rendered to a 1224×1584 PNG; an image-only PDF reported zero text items and
  rendered correctly; malformed and empty files raised `InvalidPDFException`; an encrypted file raised
  `PasswordException`.

### Three findings that shaped the code

1. **`pdfjs-dist` requires Node `>=22.13.0 || >=24`.** The repository declared `>=20.11`, which was
   therefore a false floor the moment this landed. `package.json` `engines` is raised to `>=22.13.0` in
   the same commit.
2. **`document.destroy()` does not exist in v6.** The lifecycle owner is the *loading task*. All
   teardown goes through `withPdfDocument`, which destroys the task in a `finally` on every path.
   This is the API-instability risk arriving on day one, not hypothetically.
3. **`standardFontDataUrl` must be a URL ending in `/`.** A native Windows path is rejected outright,
   and `join(dir, "x/")` drops the trailing separator. Built with `pathToFileURL` plus an explicit slash.

## Explicitly out of scope

Not used, not wrapped, and not to be added without a new decision: **OCR of any kind**; PDF *writing* or
editing; form/AcroField extraction; annotation handling; digital-signature verification; decryption of
password-protected documents; multi-provider OCR or rendering abstractions; browser-side rendering; any
image operation beyond "render this page to PNG".

Fixtures deliberately do **not** use `@napi-rs/canvas`, even where it would be convenient: the raw RGB
image XObject in `lib/extract/testing.ts` needs no encoder, and keeping the containment test meaningful
is worth more than the convenience.

## Risks accepted

- **Native binaries.** `@napi-rs/canvas` ships platform binaries. A platform without one — or a
  deployment base image whose libc does not match — fails at install or first render rather than
  degrading. Mitigated by the port: the failure is a typed `RENDERING_FAILED` inside one module.
- **pdf.js release cadence.** 5.6 → 6.2 in four months, with a breaking lifecycle change in that window.
  Mitigated by declaring the exact API surface used as a local interface in `pdf.ts`, so a bump breaks
  compilation at one file rather than silently changing behaviour.
- **A raised Node floor**, from 20.11 to 22.13.

## Reconsider when

- **Native-binary portability fails** — a target platform or base image has no prebuilt
  `@napi-rs/canvas`, or the binary fails to load in the deployment container. Replace the renderer with a
  WASM engine (`@hyzyla/pdfium` was the evaluated alternative); the port means only `render.ts` changes.
- **Node-version support conflicts** — a hosting platform pins a runtime below `22.13.0`, or `pdfjs-dist`
  raises its floor past what the deployment target offers.
- **The pdf.js API moves again** in a way the local interface in `pdf.ts` cannot absorb, or a major
  release changes text-extraction output shape. Pin and re-verify against the fixtures before upgrading.
- **A deployment platform is incompatible** — a serverless runtime that forbids native modules, or an
  execution model where the pdf.js worker cannot start. Both would force the WASM path above.
- **OCR becomes a requirement** — that is a separate decision with its own accuracy and cost evidence,
  and must not be smuggled in as an option flag on the renderer.
- **The text-layer threshold proves wrong.** Today a document with zero non-whitespace characters is
  `image-only`. Whether a *degenerate* layer — page numbers only, or someone else's partial OCR — should
  also route to the scanned path is an M2b question that needs a real corpus, not a percentage guessed at
  now.
