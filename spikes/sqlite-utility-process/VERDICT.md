# Verdict: better-sqlite3 in an Electron utility process (PROTOTYPE)

**Question:** Does better-sqlite3 (with FTS5) load and work inside an Electron `utilityProcess`, in dev and in a packaged asar build?

**Answer: yes, on macOS arm64, Electron 45.5.0, better-sqlite3 13.2.0.**

| | Dev (`npm start`) | Packaged asar (`npm run package && npm run start:packaged`) |
|---|---|---|
| Module load in utility process | 2.2 ms | 2.7 ms |
| SQLite version / FTS5 | 3.54.1 / yes | 3.54.1 / yes |
| Insert 100,000 rows + FTS5 index, one transaction | 280 ms | 268 ms |
| FTS5 queries, `limit 50` over 100,000 rows | 0.1 to 9.6 ms | same range |
| Main to utility process round trip, whole run | 450 ms | 356 ms |

**What we learned:**

- better-sqlite3 13 ships Node-API prebuilds for every platform (`prebuilds/*.node`), so it is ABI-stable across Node and Electron. No `electron-rebuild` is needed; the spec's "needs a rebuild for Electron" no longer holds.
- electron-builder 26 unpacks `.node` files from the asar automatically, even with `asarUnpack` cleared. An explicit rule is harmless but redundant.
- npm 12 blocks install scripts by default. better-sqlite3's script must be approved (`npm install-scripts approve better-sqlite3`), recorded under `allowScripts` in package.json. Electron 45 downloads its binary on first run, not at install.
- All eight platform prebuilds get packaged. The real build should exclude the ones for other platforms.
- FTS5 search over 100,000 synthetic rows sits well under the 100 ms budget. Real mail bodies are larger, so the milestone 1 harness still has to measure it on realistic data.

**Not tested:** Windows and Linux (out of v1 scope); a signed and notarized build (v1 is unsigned).
