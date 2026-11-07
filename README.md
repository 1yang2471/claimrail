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
| "It's easy to revert" | Cost is computed from fan-in, whether the artifact is published, and side effects; the model may only raise it |
| "The screenshot proves it's fine" | Screenshot must be newer than the last code change; `null` (undecided) items in the report never count as passing |
| "I followed the existing pattern" | Re-reads the cited `file:line`; lines added/modified in this session don't count as an existing pattern |
| "I remember you rejected X" | `log#n` must exist and match; a misaligned line number is a hard error |
| "There are no forks in this task" | Invisible to the gate. This is the one known hole — auditable via `no_fork_reason`, not pretended to be caught |

## Usage

Once installed, use the `claimrail` command (from a repo checkout, `node src/cli.mjs` works the same):

```bash
claimrail init              # ledger template + AGENTS.md pointer + baseline
claimrail check             # pre-delivery check; exit code 0 lets it through
claimrail web --url http://127.0.0.1:5173/   # two viewports, five geometry checks (needs playwright)
claimrail record --key ui.spacing --what "no overlay scrollbars" --why "covers right-aligned bubbles"
claimrail rules             # current rules + raw rejections + provenance
claimrail invalidate <key>  # retract a rule; the raw log is untouched
claimrail --help            # all commands and flags
```

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

The PRD calls for 20–30 trap tasks before any "silent-collapse rate" can be quoted publicly. `bench/tasks/` currently holds 6 tasks drawn from real failures; real-model runs so far are a small sample against a local Anthropic-compatible gateway (`autoclaw-cn/zai_glm-5.3-flash`) — enough to see direction, not enough to write copy.

Numbers produced by the fake agent are mechanism self-tests, not a model's behaviour distribution.

**So: the comparison numbers in any release copy are not yet measured.** Raw records live in `docs/HANDOFF.md`; nothing has been cherry-picked.

## Known limits

- Non-git directories: all three cost inputs are unavailable → everything grades `high`; the tool is nearly blind there.
- Contrast on frosted/gradient backgrounds used to be unjudgeable (7/111 texts on a real site). It is now sampled from screenshot pixels (v2) — but a text whose sample points straddle a gradient or land on the glyphs themselves is still reported as undecided, not as passing.
- SPA shells expose no readable text: `m3.material.io` returns 200 with 62KB of HTML and 15 visible characters. Most design-system sites are like this, so the `precedent` tier can't reach them.
- A quote being present does not mean the page *recommends* the practice. Two real hits were exception clauses; `url + quote` exists so a reviewer can check the surrounding context. That human check is the only defence in this tier.
- The logged-in flow against a real protected page has not been run (`--state` cookie/localStorage injection is verified against a local page).
- `newestTrackedMtime` caps at 5000 files and returns `null` beyond that — render evidence fails wholesale in large monorepos.

## Development

```bash
node --test    # 274 tests: pure logic / real git repos / real Chromium / CLI loop
```

The real-Chromium file skips entirely when Playwright is absent — never a fake green. Read `AGENTS.md` before changing code: every rule names what enforces it, and each new guard requires a mutation check (break it, watch it go red; restore, watch it go green).

## License

MIT, see [LICENSE](LICENSE).
