# Dependency Overrides

> **Why this file exists** — An `overrides` block forces a transitive dependency to a version its parent
> never asked for. That is a real risk (a parent may rely on the older API) accepted for a real reason, and
> if the reason is not written down it becomes project folklore that nobody dares remove. Every entry below
> states the condition under which it should be deleted.
>
> **Last verified** — 2026-07-29, against `package-lock.json` after `drizzle-kit` removal.
> **Verification command** — `npm audit` must report `found 0 vulnerabilities`, and `npm run check` must pass.

## How to re-verify an entry

An override is load-bearing only if removing it reintroduces the advisory. Test one at a time:

```sh
# Remove a single entry from package.json "overrides", then:
npm install --no-audit --no-fund && npm audit
```

If `npm audit` still reports 0 vulnerabilities, the upstream ranges have caught up — **delete the entry**
and update this file. Do not keep an override "just in case".

> **A shallow check is misleading.** `npm why <pkg>` reports the top resolution only. A package can appear
> patched there while older major lines of it still sit deeper in the tree under other parents. This was not
> hypothetical: `brace-expansion` looked unnecessary by that method and turned out to be load-bearing on two
> other paths. Trust `npm audit` after a real reinstall, not a dependency-graph reading.

---

## Active overrides

### `sharp` → `^0.35.3`

| | |
|---|---|
| **Advisory** | Inherited libvips vulnerabilities: CVE-2026-33327, CVE-2026-33328, CVE-2026-35590, CVE-2026-35591 |
| **Vulnerable range** | `<0.35.0` · high |
| **Introduced by** | `next@16.2.12`, which declares `optional sharp@"^0.34.5"` |
| **Forced to** | `0.35.3` |
| **Why an override** | Next's own range caps at `^0.34.5` and cannot reach a patched release. No Next 16 version currently resolves past the advisory. |
| **Risk accepted** | A minor-version bump within `sharp`'s 0.3x line, used by Next for image optimisation. This project does not use `next/image` for client documents, so the blast radius is near zero. |
| **Remove when** | A Next.js release declares `sharp@^0.35.0` or later. Then delete and confirm `npm audit` stays clean. |

### `postcss` → `^8.5.18`

| | |
|---|---|
| **Advisory** | Arbitrary file read via attacker-controlled `sourceMappingURL`; path traversal in source-map auto-loading; XSS via unescaped `</style>` in stringify output |
| **Vulnerable range** | `<=8.5.17` · high |
| **Introduced by** | `next@16.2.12` (pins `8.4.31`) and `vite@7.3.6` via `@vitest/mocker` (`^8.5.6`) |
| **Forced to** | `8.5.24` |
| **Why an override** | Two independent parents, both below the patched line. Next pins an exact version, so it cannot float up at all. |
| **Risk accepted** | Patch-level movement inside PostCSS 8. Build-time only. |
| **Remove when** | Both Next.js and Vite declare ranges resolving to `>=8.5.18`. |

### `brace-expansion` → `^5.0.8`

| | |
|---|---|
| **Advisory** | DoS via unbounded expansion length causing an out-of-memory crash ([GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg)) |
| **Vulnerable range** | `<=5.0.7` · high |
| **Introduced by** | Multiple paths under `typescript-eslint@8.65.0` (via `eslint-config-next`). The `minimatch@10.2.6` path already asks for `^5.0.8`; **other paths resolve to `1.1.16` and `2.1.3`, which are the vulnerable ones.** |
| **Forced to** | `5.0.8` |
| **Why an override** | The 1.x and 2.x lines are still pulled by parents whose ranges cannot reach 5.x. Removing the override reintroduced 15 high-severity findings (verified 2026-07-29). |
| **Risk accepted** | A major-version force on a package whose public surface is a single exported function. Lint and tests pass on it. Dev-only: never shipped. |
| **Remove when** | No `brace-expansion@1.x` or `2.x` remains in `npm ls brace-expansion --all`. |

---

## Removed overrides

### `esbuild` → `^0.25.12` — removed 2026-07-29

Forced past [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99) because
`drizzle-kit@0.31.10` pulled the deprecated `@esbuild-kit/*` chain, which pinned `~0.18.20` and would never
move. **`drizzle-kit` was removed from the project** (see
`docs/decisions/0001-sql-migrations-as-the-single-authority.md`), taking that chain with it. `npm audit`
reports 0 vulnerabilities without the override.

Do not re-add it from the advisory alone: it is only needed if something reintroduces `@esbuild-kit/*`.
