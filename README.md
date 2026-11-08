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
| "There are no forks in this task" | Not blocked — this is the one known hole. The program records `no_fork_reason`; when `forks: []` and the diff touches files of that task class, `check` prints an audit item and `check --json` exposes `emptyDeclaration` (touched files and total). It cannot tell whether a fork existed — it only makes the escape countable |

## Usage

Not on npm yet (`npm view claimrail` returns 404). Install from source:

```bash
git clone https://github.com/1yang2471/claimrail.git
cd claimrail && npm install && npm link   # npm link puts the claimrail command on PATH
```

Then use `claimrail`; from a repo checkout, `node src/cli.mjs` works the same:

```bash
claimrail init              # ledger template + AGENTS.md pointer + baseline
claimrail check             # pre-delivery check; exit code 0 lets it through
claimrail web --url http://127.0.0.1:5173/   # two viewports, five geometry checks (needs playwright)
claimrail record --key ui.spacing --what "no overlay scrollbars" --why "covers right-aligned bubbles"
claimrail rules             # current rules + raw rejections + provenance
claimrail invalidate <key>  # retract a rule; the raw log is untouched
claimrail --help            # all commands and flags
```

`check --json` prints the same verdict as structured JSON (for hosts and scripts) — the text is a view of that one decision, not a second calculation.

`check` does not touch the network by default. The `precedent` and `web` evidence tiers need real re-fetching, so they require `--allow-net` — an explicit outbound request.

`web` depends on Playwright (an optional peer dependency). Without it, `web` fails loudly rather than pretending to have checked.

### Wiring it into an agent

Two steps: **pointing** (required, written by `init`) and **installing the skill** (optional, lets the agent load the protocol on its own).

**Pointing**: `init` appends a marker block to the target repo's `AGENTS.md` (idempotent, existing content untouched) that points at `node_modules/claimrail/skill/SKILL.md`. This is the wiring that measurably works: relying on the skill description alone, ZCode 0.17.1 ran three design tasks without ever loading claimrail.

**Installing the skill** (optional): `npm install` puts the skill in the package but does **not** register it in your host's skills directory. To let the agent load it on demand, link it where the host scans (shown for `~/.agents/skills`, shared by ZCode / CodeBuddy / Trae):

```bash
# Linux / macOS
ln -s "$(pwd)/node_modules/claimrail/skill" ~/.agents/skills/claimrail
# Windows (admin or developer mode)
mklink /D "%USERPROFILE%\.agents\skills\claimrail" "%CD%\node_modules\claimrail\skill"
```

Skipping this is fine: the `AGENTS.md` block gives a real file path, so the agent can just read it — it simply won't load the protocol unprompted.

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

`hook` reads the event from stdin; exit code 2 means "block and continue one more turn", with stderr handed to the model. Repos without a ledger pass silently; once a turn has already been continued, `stop_hook_active` prevents blocking again (otherwise it loops forever).

## Benchmarks: not yet measured

The PRD calls for 20–30 trap tasks before any "silent-collapse rate" can be quoted publicly. `bench/tasks/` now holds **20 tasks**, each documenting why it is not invented (pointing at real failures recorded in `docs/`: exception-clause quotes, SPA shells, `shot_sha256` binding, four truncation classes, the `git push origin HEAD:main` publication rule, etc.). `test/bench.test.mjs` checks that explanation and the counting rule for every task.

The first real-model pass (`hub-qiniu/conatus-free`, local Anthropic-compatible gateway) ran all 20 tasks on the off arm with a 6-step budget, and **the data is invalid**: 7 runs were voided by 429 rate limits, and of the 13 valid runs only 1 ended naturally and delivered — the other 12 hit the step cap. With retry and incremental writing in place, a 10-step, 6-task two-arm pilot completed with 12/12 valid runs — and it mostly measured something else. On the protocol arm the model wrote no ledger in 5 of 6 runs (the `init` template stayed untouched), so the gate never had a chance to judge. The one run that did write a ledger — 3 forks, all `evidence: null` — was blocked by `check` (exit 1). On the off arm, 5 of 6 runs delivered; 2 of those 5 were counted as silent collapse under the tasks' own rules (nothing was declared). The pilot also exposed two counting bugs — two tasks had no trap rule, so any delivery counted as a trap, and a model that explicitly refused to delete was counted as having deleted — both fixed and tested.

**The protocol arm's zero deliveries are therefore not evidence that the gate works**: 5/6 never entered the protocol. A collapse rate needs delivery as its precondition, and a valid comparison needs runs in which the model actually writes a ledger. The release comparison number stays "not measured". Raw rows and the three-way counting rule are in `docs/AUDIT-2026-11-08.md`; nothing has been cherry-picked.

## Known limits

- Non-git directories: all three cost inputs are unavailable → everything grades `high`. This is now an **explicit degraded mode**, not a silent one: the report says so up front, and says which check was lost (repo evidence can still be read, but "did you just write this?" cannot be answered without git). A broken git setup (`GIT_DIR`, `safe.directory`) is reported differently from "this is not a repository" — the first wants your environment fixed, the second wants `git init`.
- Contrast on frosted/gradient backgrounds used to be unjudgeable (7/111 texts on a real site). It is now sampled from screenshot pixels (v2) — but a text whose sample points straddle a gradient or land on the glyphs themselves is still reported as undecided, not as passing.
- Text over a busy image background is reported as **undecided**, not as passing. A 10px checkerboard used to be judged as one cell's colour (reported 6.80 — passing — while the same text over the white cells was 1.67); now a background whose sampled points disagree wildly is left undecided.
- Modern CSS colour syntaxes used to be skipped wholesale: on `iana.org/help/example-domains`, 40 of 49 text runs are coloured with `oklch()`, and the report blamed "no solid background sampled" — pointing at the background when the foreground was what went unread. Colours are now resolved by the browser itself (one pixel painted and read back), so `oklch()`, `lab()`, `color()` and `color-mix()` are judged too: that page now measures 49/49 and turns up 31 real defects, the worst at 2.45:1. Anything the browser itself rejects is still reported as undecided.
- SPA shells expose no readable text: `m3.material.io` returns 200 with 62KB of HTML and 15 visible characters. Most design-system sites are like this, so the `precedent` tier can't reach them.
- A quote being present does not mean the page *recommends* the practice. Two real hits were exception clauses; `url + quote` exists so a reviewer can check the surrounding context. That human check is the only defence in this tier.
- The logged-in flow is verified against a local login-gated site (anonymous → redirected to `/login`; with `--state` → real content collected). A third-party production page has not been run — that needs your credentials.
- `newestTrackedMtime` stats every tracked file. The cap is 200,000 — high enough that no real repo hits it (6000 files measured at 148ms); beyond it, render evidence is reported undecided rather than guessed.

## Development

```bash
node --test    # 354 tests: pure logic / real git repos / real Chromium / CLI loop
```

The real-Chromium file skips entirely when Playwright is absent — never a fake green. Read `AGENTS.md` before changing code: every rule names what enforces it, and each new guard requires a mutation check (break it, watch it go red; restore, watch it go green).

## License

MIT, see [LICENSE](LICENSE).
