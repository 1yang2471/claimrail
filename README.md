# claimrail

English | [中文](README.zh-CN.md)

A *claim* is what the AI says it did: it verified the design, checked the screenshot, followed the existing pattern. A *rail* is the bar it clears before shipping. The name is the mechanism.

When the spec isn't finished, an AI still has to output *something* — so it outputs the most common thing it has seen. What you get back looks like a finished decision. The fork in the road was taken, and nothing records that a fork ever existed.

claimrail closes the gate before delivery. The AI must first write a decision ledger (which forks it hit, what the options were, which it picked, and on what grounds). A program computes the cost of each change and re-visits every claimed piece of evidence. If the check fails, nothing ships.

It does not make AI tasteful. It stops AI from passing off guesses as evidence.

## What it catches

| Claim | How the program checks it |
| --- | --- |
| "Everyone does it this way" | Re-fetches ≥3 independent registrable domains; the quote must appear in the page's *visible text* — inside `<script>` does not count |
| "It's easy to revert" | Cost is computed from fan-in, whether HEAD is on the published default branch or tagged, and side effects; the model may only raise it |
| "The screenshot proves it's fine" | Screenshot must be newer than the last code change; `null` (undecided) items in the report never count as passing |
| "I followed the existing pattern" | Re-reads the cited `file:line`; lines added/modified in this session don't count as an existing pattern |
| "I remember you rejected X" | `log#n` must exist and match; a misaligned line number is a hard error |
| "There are no forks in this task" | If the ledger is still the `init` template and the diff is non-empty, `check` exits 1: nothing ships until the agent writes a declaration. A written `forks: []` plus `no_fork_reason` counts as a declaration; when the diff touches files of that task class, `check` prints an audit item and `check --json` exposes `emptyDeclaration`. The program cannot tell whether a fork existed — it only makes the escape countable |

## Usage

Not on npm yet (`npm view claimrail` returns 404). Install from source:

```bash
git clone https://github.com/1yang2471/claimrail.git
cd claimrail && npm install && npm link   # npm link puts the claimrail command on PATH (junction/symlink install works — the CLI resolves its own real path)
```

Then use `claimrail`; from a repo checkout, `node src/cli.mjs` works the same:

```bash
claimrail init              # ledger template + AGENTS.md pointer + baseline
claimrail check             # pre-delivery check; exit 0 lets it through; an untouched ledger template blocks
claimrail web --url http://127.0.0.1:5173/   # two viewports, five geometry checks (needs playwright)
claimrail record --key ui.spacing --what "no overlay scrollbars" --why "covers right-aligned bubbles"
claimrail rules             # current rules + raw rejections + provenance
claimrail invalidate <key>  # retract a rule; the raw log is untouched
claimrail skill             # print the protocol; works in any target repo (no node_modules needed)
claimrail --help            # all commands and flags
```

`check --json` prints the same verdict as structured JSON (for hosts and scripts) — the text is a view of that one decision, not a second calculation.

`check` does not touch the network by default. The `precedent` and `web` evidence tiers need real re-fetching, so they require `--allow-net` — an explicit outbound request.

`web` depends on Playwright (an optional peer dependency). Without it, `web` fails loudly rather than pretending to have checked.

### Wiring it into an agent

Two steps: **pointing** (required, written by `init`) and **installing the skill** (optional, lets the agent load the protocol on its own).

**Pointing**: `init` appends a marker block to the target repo's `AGENTS.md` (idempotent, existing content untouched) that tells the agent to run `claimrail skill` and read the protocol it prints. The command reads the skill from the installed package itself, so the target repo does not need `node_modules/claimrail` — it works for Python/Go repos too. This is the wiring that measurably works: relying on the skill description alone, ZCode 0.17.1 ran three design tasks without ever loading claimrail.

**Installing the skill** (optional): `npm install` puts the skill in the package but does **not** register it in your host's skills directory. To let the agent load it on demand, link it where the host scans (shown for `~/.agents/skills`, shared by ZCode / CodeBuddy / Trae):

```bash
# Linux / macOS (run from the claimrail source checkout)
ln -s "$(pwd)/skill" ~/.agents/skills/claimrail
# Windows (admin or developer mode)
mklink /D "%USERPROFILE%\.agents\skills\claimrail" "%CD%\skill"
```

Skipping this is fine: the `AGENTS.md` block names a real command (`claimrail skill`), so the agent can read the protocol on demand — it simply won't load it unprompted.

Stop hook (ZCode, `~/.zcode/cli/config.json`):

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "Stop": [
        {
          "hooks": [
            { "type": "command", "command": "node \"<repo>/src/cli.mjs\" hook", "timeout": 30 }
          ]
        }
      ]
    }
  }
}
```

`hook` reads the event from stdin; exit code 2 means "block and continue one more turn", with stderr handed to the model. Repos without a ledger pass silently; once a turn has already been continued, `stop_hook_active` prevents blocking again (otherwise it loops forever). Add `--allow-net` to the hook command only if your ledger uses `precedent`/`web` evidence and you consent to outbound fetches on every Stop.

## Benchmarks: 20 trap tasks × 2 arms (measured 2026-11-11)

`bench/tasks/` holds **20 trap tasks**, each documenting why it is not invented (pointing at real failures recorded in `docs/`: exception-clause quotes, SPA shells, `shot_sha256` binding, four truncation classes, the `git push origin HEAD:main` publication rule, etc.). `test/bench.test.mjs` checks that explanation and the counting rule for every task.

`bench/run-real.mjs` then ran those tasks twice: once with a plain system prompt (`off`), once with `claimrail init` and the protocol system prompt (`on`). Model: `workbuddy-ai/deepseek-v4.1-flash-sg` through a local Anthropic-compatible gateway; 20-step budget; network enabled (`FK_ALLOW_NET=1`). Rows: `docs/bench-2026-11-11-off.json` and `docs/bench-2026-11-11-on.json` (compact; model prose and design excerpts omitted). Seventeen rows were rerun after gateway resets/timeouts; one of those timed out a second time and needed a third run. All 20 × 2 pairs now have a valid row.

| | off (plain prompt) | on (init + protocol prompt) |
| --- | --- | --- |
| valid runs | 20 | 20 |
| ended naturally | 12 | 9 |
| delivered | 12 | 6 |
| silent collapse (delivered + trap taken + not surfaced) | 4/12 (33%) | 0/6 (0%) |
| delivered with the unresolved item surfaced | 0 (no gate run) | 4 |
| trap taken at all | 4 | 0 |
| `check` blocked / proceeded | — | 9 / 11 |
| interruptions per run, median | — | 0 (n=18) |
| wall time, median | 221 s | 174 s |
| extra time vs off | — | −16 s median over all 20 pairs; +23 s when both arms delivered (n=3) |

How to read this:

- **The denominators are not the same.** `on` counts a delivery only when the model ended naturally, changed the ledger, and `check` exited 0. The off arm's 8 non-deliveries are step-cap runs, not protocol rejections — so the collapse rate is reported over deliveries (4/12), and over all off runs it is 4/20.
- **The gate is Stop-time.** It blocks before *delivery*, not before the first edit; this harness cannot measure "blocked before acting". What it does measure is "the run could not hand in a green delivery".
- **This is one model, one run per pair.** It is direction, not a universal silent-collapse rate. All rows are kept, including the reruns; nothing was cherry-picked. Some `fetch_url` calls failed in-run, so the protocol arm gathered less external evidence than it would on a stable network.
- **Cost is real.** 11/20 protocol-arm runs hit the 20-step cap, so the arm spends budget on the protocol. The median interrupt count is 0 (target ≤1), but only 3 pairs delivered on both arms, too few to claim the PRD's ≤90 s overhead target generally.
- **The fail-closed `undeclared` block fired on a real model** once: `empty-declaration@on` ran to the step cap with the `init` template untouched, and `check` exited 1. Previously this path had only unit-test evidence.

Earlier pilots and their caveats remain in `docs/AUDIT-2026-11-08.md` and `docs/bench-pilot-2026-11-0{8,9}.json`.

## Known limits

- Non-git directories: all three cost inputs are unavailable → everything grades `high`. This is now an **explicit degraded mode**, not a silent one: the report says so up front, and says which check was lost (repo evidence can still be read, but "did you just write this?" cannot be answered without git). A broken git setup (`GIT_DIR`, `safe.directory`) is reported differently from "this is not a repository" — the first wants your environment fixed, the second wants `git init`.
- Contrast on frosted/gradient backgrounds used to be unjudgeable (7/111 texts on a real site). It is now sampled from screenshot pixels (v2) — but a text whose sample points straddle a gradient or land on the glyphs themselves is still reported as undecided, not as passing.
- Text over a busy image background is reported as **undecided**, not as passing. A 10px checkerboard used to be judged as one cell's colour (reported 6.80 — passing — while the same text over the white cells was 1.67); now a background whose sampled points disagree wildly is left undecided.
- Modern CSS colour syntaxes used to be skipped wholesale: on `iana.org/help/example-domains`, 40 of 49 text runs are coloured with `oklch()`, and the report blamed "no solid background sampled" — pointing at the background when the foreground was what went unread. Colours are now resolved by the browser itself (one pixel painted and read back), so `oklch()`, `lab()`, `color()` and `color-mix()` are judged too: that page now measures 49/49 and turns up 31 real defects, the worst at 2.45:1. Anything the browser itself rejects is still reported as undecided.
- SPA shells expose no readable text: `m3.material.io` returns 200 with 62KB of HTML and 15 visible characters. Most design-system sites are like this, so the `precedent` tier can't reach them.
- A quote being present does not mean the page *recommends* the practice. Two real hits were exception clauses; `url + quote` exists so a reviewer can check the surrounding context. That human check is the only defence in this tier.
- The logged-in flow is verified against a local login-gated site, and against a real third-party site (saucedemo.com, using the demo credentials it publishes on its own login page — gated behind `FK_NET=1` so nothing is sent by default). A page behind *your* real credentials has not been run.
- `newestTrackedMtime` stats every tracked file. The cap is 200,000 — high enough that no real repo hits it (6000 files measured at 148ms); beyond it, render evidence is reported undecided rather than guessed.

## Development

```bash
node --test    # 407 tests: pure logic / real git repos / real Chromium / CLI loop
```

The real-Chromium file skips entirely when Playwright is absent — never a fake green. Read `AGENTS.md` before changing code: every rule names what enforces it, and each new guard requires a mutation check (break it, watch it go red; restore, watch it go green).

## License

MIT, see [LICENSE](LICENSE).
