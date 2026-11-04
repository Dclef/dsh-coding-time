# dsh-coding-time

Local coding-activity timing for the DeepSeek Harness (DSH): wall-clock active
intervals per project (`cwd`), added/deleted line accounting from **real diff
metadata**, and optional human-edit timing. Everything stays on this machine
under `~/.dsh`. It is an independent, local-only plugin.

> **This is not WakaTime.** It does not call any third-party API or CLI, does not
> register with any third-party service, has no account, token, billing,
> pomodoro timer, or watchdog process. It adds **no HTTP listener** of its own —
> the Web settings/dashboard routes mount onto the Harness's existing
> `webServer`. No outbound third-party telemetry is sent; the dashboard reads
> from the Host's same-origin local HTTP routes, and storage is local JSONL.
>
> Runtime dependencies: the timing/storage/editor-protocol code uses only Node
> built-ins. The Host's settings form additionally depends on the Host-provided
> peer `@deepseek-ai/schemastery` (declared as a `peerDependency`); it is **not**
> bundled and is used only to build the Config schema. This is a local peer, not
> a network service or third-party registration.

## Status (read this first)

> **Experimental.** This is an early, local-only plugin published as source for
> review and self-hosting. Known issue (not yet fixed): the current Host's
> `Settings.describe` does not expose a writable configuration entry for this
> plugin, so some settings controls are temporarily **not editable**. The client
> disables those controls and sends no save request; the fix is **not** complete.
> The underlying cause is still under investigation (for example, how the
> writable / live-field entry is registered) and is not stated as confirmed.
> Local Host collection has been verified working, but full browser UI
> acceptance after sign-in (editable + save) is still pending. Do not read any
> doc below as "production ready".

- The core library (`lib/activity.js`, `lib/collector.js`, `lib/store.js`,
  `lib/config.js`, `lib/routes.js`, `lib/index.js`) and the **local editor
  protocol** (`lib/editor-inbox.js`, `integrations/local-editor.js`) are
  implemented. Tests include a real end-to-end summary contract suite
  (`test/summary-contract.test.mjs`) that drives real `apply()` + events +
  `session/flush` + the real `/summary` HTTP route (no mocked `summarize`).
- **Final verification record 2026-11-05:** `npm run check` → `check ok: 9
  files`; `node --test --test-timeout=30000 --test-reporter=spec
  test/*.test.mjs` → **174 tests, 173 pass, 0 fail, 1 skipped, 0 todo**
  (~4.4s). The single skip is a Windows POSIX-permission test. Re-run
  `npm test` for the current numbers on your platform.
- **Acceptance record 2026-11-05 (historical, this checkout):** early in the
  session the plugin was not installed and the local Web GUI required
  authentication (401), so no browser acceptance was possible. Since then it
  **has** been installed into the local `desktop` profile, the backend and real
  local collection have been verified working, and the source is freezing for
  publication. The install target discussed with the user is the `web` profile;
  the `desktop` profile was used only for local verification. **Full browser UI
  acceptance after sign-in — editable settings and a successful save — is still
  pending** (see known issue above). This record contains no machine usernames,
  personal paths, session IDs, or real user data.
- Limitation that is by design, not a bug: there is **no** bundled VSCode /
  Cursor extension and **no** automatic coverage of external editors. Human
  attribution stays `false`/`unknown` until an integration with a real input
  API is connected; the plugin does not guess humans from file-change events.

## What it measures (honest accounting)

The timing core (`lib/activity.js`, `lib/collector.js`) is deliberately
conservative — it prefers under-counting to inventing time:

- **Project-level sliding 60s gate.** Within any `heartbeatIntervalSeconds`
  (default `60`) only one new record may open per normalized project (`cwd`),
  shared across sources/sessions/runs — not one minute per source. Suppressed
  observations are kept as evidence, not discarded: a suppressed segment with
  **two or more real points** whose gaps are within `idleThresholdSeconds` is
  projected as a real interval (`pending: true`, `heartbeats: 0`, duration =
  last−first). The gate limits effective-heartbeat *count*, not time evidence;
  a single isolated suppressed point stays zero-duration.
- **Idle 180s / flush 10s.** A segment is continued only while the gap to the
  previous real observation is within `idleThresholdSeconds` (default `180`),
  and only within the same segment (`source|sessionId|runId`). State is flushed
  on a `flushIntervalSeconds` (default `10`) cadence. A hard kill (SIGKILL /
  power loss) **cannot guarantee** a final flush; only graceful `SIGTERM` /
  unload attempts one.
- **Wall-clock union estimate, orphan point = 0.** Overlapping AI/human/multi-file
  intervals are merged as a time **union** — never summed, never multiplied by
  file count. A single isolated observation (start == end) contributes `0`
  seconds, no "free heartbeat", and the snapshot never extends `endMs` to "now".
- **Only real diff counts.** Added/deleted lines come exclusively from explicit
  `result.meta` line metadata. No meta → `null` (unknown), an explicit zero is
  `0`. `null` is never rendered as `0`.
- **Local JSONL + profile isolation.** Records and project state live under
  `<storageDirectory>/<profile>/` (`~/.dsh/coding-time/default` by default).
  `profile` is a single-segment safe name; `cwd`/project names are hashed into
  filenames so directory listings do not leak project paths.
- **CSV injection protection.** CSV export (`lib/routes.js`) escapes cells
  (quotes/commas/newlines) and keeps `null` distinct from `0`.
- **No live "active" detection.** The `active` flag on project rows is not a
  real-time presence signal in the current implementation; do not read it as
  "this project is being edited right now". Uncollected / not-connected states
  are `null`, never a fabricated `0`.

## Human attribution — deliberately conservative

`humanTracking.enabled` defaults to **`false`** and is controlled by the Host,
not by this plugin. The plugin does **not** auto-detect human typing.

The **local editor protocol** is the only path to human timing, and it is a
local-filesystem IPC, not a service:

- `integrations/local-editor.js` exposes
  `writeEditorHeartbeat({ directory, profile, event, now })` and
  `createEditorHeartbeatWriter({ directory, profile, now, fs })`. It writes a
  **single minimal JSON event** atomically (`.tmp` → `link`/`rename`) into
  `<storageDirectory>/<profile>/editor-inbox/<id>.json`. Duplicate `id` is never
  overwritten (idempotent; stable `id` is handed to the tracker for dedupe).
  Events carry only `id, cwd, file, sessionId/editorInstanceId, runId, at,
  source, provenance, v` — **no** content/text/commands/keystrokes/secrets.
- `lib/editor-inbox.js` exposes `consumeEditorInbox({ directory, profile,
  onEvent, enabled, now, fs, maxBatch })`. The Host calls it on its own
  poll/flush cadence and passes `enabled = config.humanTracking.enabled`. It
  strictly validates schema, absolute local `cwd`/`file` with `file` inside
  `cwd`, `profile` containment, a `source` whitelist, and volume/batch limits
  (8 KB per file, 64 per batch); it processes **only regular files** and
  **never follows symlinks**. Bad files are moved to `quarantine/`, a failing
  sink keeps the file for a later retry, and success deletes it.
- **Pass `profile` explicitly.** When the plugin is installed into the `web`
  profile, both `writeEditorHeartbeat` and `consumeEditorInbox` must be given
  `profile: 'web'` (and the matching `directory`). The parameter defaults to
  `default`, which is a different isolated directory from `DSH_PROFILE=web` —
  relying on the default would silently write events that are never consumed.
- `source` defaults to `unknown`. It becomes `human` **only** when the Host
  passes `enabled === true` **and** the integration supplies explicit real-input
  provenance (`kind` in `keyboard | ime | pointer-edit` with `explicit: true`).
  `fs.watch`, `onDidChangeTextDocument`, save events, git author, or any file
  change are **never** inferred as human — they stay `unknown`.

**`source`/`human` are local source *declarations*, not cryptographic proof.**
This plugin does **not** ship a VSCode/Cursor extension and does **not** claim to
automatically cover external editors. If an integration has no real input API,
it is simply **not connected**, and human time stays `false`/`unknown`. There is
no automatic guessing of humans.

## Install

Install into the **`web`** profile (the user's requested target):

```
dsh plugin --profile web add 'E:/github project/dsh-coding-time'
```

Install prerequisites (general): a Node `>=22.14.0` runtime and a running
Harness instance whose `dsh` CLI is available on the `PATH` of the shell you use
(if `dsh` is not found, locate the Harness CLI or invoke it through the
environment that exposes it). These are ordinary install requirements, not
checkout-specific facts.

Acceptance note for **this session only** (not a permanent product requirement):
during this work the active runtime was `DSH_PROFILE=desktop` while the requested
install target is `web`; this checkout did **not** change the running `desktop`
profile and was not authorized to. The Web GUI at the session's local address
required authentication, so no browser-side acceptance was performed here. None
of the `PATH`, profile, or GUI-address details above are product constraints —
they describe only what was observed during this particular acceptance pass.
This doc does **not** claim the plugin is installed, enabled, or browser-verified;
confirm that yourself in the running Harness after install.

## Configuration (defaults, from `lib/config.js`)

| Field | Default |
| --- | --- |
| `enabled` | `true` |
| `heartbeatIntervalSeconds` | `60` (sliding project gate) |
| `idleThresholdSeconds` | `180` |
| `flushIntervalSeconds` | `10` |
| `trackAgentActivity` | `true` |
| `trackAiLines` | `true` |
| `humanTracking.enabled` | **`false`** |
| `storageDirectory` | `~/.dsh/coding-time` |
| `timezone` | local IANA zone (falls back to UTC) |
| `weekStartsOn` | `1` (Monday) |
| `exclude` | `.git`, `node_modules`, `dist`, `build`, `coverage`, `.venv`, `.env`, `*.pem`, `*.key`, `id_rsa`, `.ssh`, `secrets` |

`normalizeConfig` is strict: unknown fields, credential fields, invalid numbers
/ timezone / non-absolute directory are rejected, not silently clamped.
`idleThresholdSeconds` must be `>= heartbeatIntervalSeconds`.

## Development & verification

```
npm test                                   # full suite (final numbers: see Status)
node --test --test-timeout=30000 --test-reporter=spec test/*.test.mjs
npm run check                              # checks every lib/client/integrations .js file
node --test test/summary-contract.test.mjs # real apply + /summary E2E contract
node --test test/editor-inbox.test.mjs     # local editor protocol suite
npm pack --dry-run                         # offline packaging check, no publish
```

`npm pack` is used only to verify what would be packaged — no publish is
performed. `package.json`'s `files` array includes `README.md`, `README.zh.md`,
`docs/`, `LICENSE`, `lib/`, `integrations/`, `client/`, `locale/`,
`cordis.patch.yml`, and `icon.svg` (verify with `npm pack --dry-run` for your
version). The editor-protocol suite (`test/editor-inbox.test.mjs`) and the
summary-contract E2E suite (`test/summary-contract.test.mjs`) live in `test/`
and are for development; they are not part of the published package.

## License

MIT — see [LICENSE](LICENSE).

Chinese documentation: [README.zh.md](README.zh.md). Install details:
[docs/INSTALL.md](docs/INSTALL.md).
