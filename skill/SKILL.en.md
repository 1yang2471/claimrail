# claimrail (English)

> Read this whole file before you start. If this change has more than one reasonable implementation, the protocol applies — **even if you think it's small**. "It's a small change" is the most common escape hatch, not a reason.

Where the spec is silent you must output something, so you output the most common thing you've seen. That is not a taste problem, it's a distribution problem. This skill turns that step into a **visible decision**: declare the fork first, let a program compute what it costs to undo, and make the evidence re-visitable. Red does not ship.

The force does not come from how carefully you read this page. It comes from `claimrail check`'s exit code.

## 1. Does this task go through the protocol?

Judge by `task_class`, never by "this one looks simple":

- Through the protocol: `ui-new` `docs-new` `api-design` `refactor`
- Not through: `typo` `rename` `bugfix-known-cause` (write `"forks": []` plus a one-line `no_fork_reason`)

Declaring "no forks" is allowed but always recorded. A category that never grows a fork is where the escape happens.

If the diff touches files of that task class (UI / docs / API), `check` also prints an audit item. It does not block delivery — but **an untouched ledger template with a non-empty diff makes `check` exit 1**; only `forks: [] + no_fork_reason` counts as a declaration. The audit item is not noise; it is the first place a reviewer looks.

## 2. Write the ledger

`.claimrail/decisions.json`:

```jsonc
{
  "schema": 1,
  "task_class": "ui-new",
  "forks": [
    {
      "fork": "Chat scroll area: overlay scrollbar or reserved gutter",
      "options": ["overlay", "reserve gutter"],
      "picked": "reserve gutter",
      "evidence": { "kind": "repo", "ref": "src/Chat.tsx:88", "asserts": ["scrollbar-gutter"] },
      "target": { "file": "src/Chat.tsx", "symbol": "MessageList" },
      "cost_if_wrong": "low",
      "verified": true
    }
  ]
}
```

Rules, not suggestions:

- `options` needs at least two entries. If you can only think of one, you haven't found the fork — it doesn't mean there isn't one.
- **Design-class forks (`ui-new` / `docs-new` / `api-design`) default to per-candidate targets**: write options as `{ "label": "overlay", "target": { "file": "src/Chat.tsx" } }`. The rule "no evidence + picked the pricier option → blocked" (the anti-collapse guard against "the thing I've seen most") **only arms for forks with targets on every option** — skipping it means giving up that check; if you truly can't, say why in the delivery notes, don't skip it silently.
- One field per line, no inline code. The ledger goes into git for humans to review.
- `cost_if_wrong` can only be raised by you. The program computes its own grade; if yours is lower it gets overwritten and printed — that overwrite is the place to think again.
- When `evidence` is `null`, `verified` must be `false`. "I haven't checked yet" is a legal state; "I didn't check but said I did" is not.
- `verified` is a declaration for humans and reviewers only; `check` does not trust it — evidence is still re-verified item by item. Do not treat it as a bypass.
- Write down the forks you're unsure about, even if you plan to take the default. **An undeclared fork is the only thing this mechanism cannot catch.**

## 3. Five evidence tiers

Local tiers first (cheap, offline, authoritative). What they look like:

- **repo** (existing practice in this repo) — `{ "kind": "repo", "ref": "src/Chat.tsx:88", "asserts": ["scrollbar-gutter"] }`.
- **memory** (this repo's recorded rejections) — `{ "kind": "memory", "ref": "log#16", "asserts": ["overlay scrollbar"] }`; ref is always `log#n`, asserts are ≥3-char keys that match that log entry's content. `claimrail record` writes this file.
- **render** (real-browser report) — `{ "kind": "render", "ref": ".claimrail/shots/name.png", "asserts": [ids of checks that passed] }`; **copy the paste-ready line from the end of `claimrail web` output, never write it by hand** — writing a null (not-judged) as "verified" is the one thing this mechanism must never do.

Then:

- **precedent (industry convergence)** — for design tasks, when neither `repo` nor `memory` gives you grounds, you must use this tier; taking "the most common approach" directly is not allowed. `repo` answers "how is this codebase consistent", not "what is the accepted good practice"; a greenfield project has no former, and aligning only with the repo pins output at the average forever. This tier exists to counter "AI ships what it has seen most".

  ```jsonc
  "evidence": {
    "kind": "precedent",
    "sources": [
      { "url": "https://alpha.dev/guide", "quote": "recommends an 8pt grid for list item spacing" },
      { "url": "https://beta.design/guide", "quote": "…" },
      { "url": "https://gamma.io/guide",  "quote": "…" }
    ],
    "adoption": { "repo": "primer/css", "minStars": 5000 }   // optional; star count is read live from the GitHub API
  }
  ```

  How the program checks it: **each URL is re-fetched and the quote must actually be on that page's visible text**; deduplicated by registrable domain it needs **≥3 independent domains** (three blogs reposting one article is not three votes); `adoption` numbers are read from the API, never from a claim. So "this product has a great review score" can't be said here — which is exactly why it couldn't be said before.

- **web**: a supplementary single source. For `ui-new` / `docs-new` / `api-design` the schema **rejects** this tier outright: a design decision cannot rest on one article.

Stop when you have enough: `repo → memory → render → precedent → web`. If the first four can settle it, don't go further; when none apply, the answer is "ask a human", not "go with the default".

**Hook context (the Stop hook runs offline by default)**: `precedent` / `web` evidence cannot re-verify inside the hook ("not consented") → it counts as "no evidence". So: for design forks **prefer the three local tiers** (repo/memory/render); when only `precedent` can work, say so in the delivery ("this one needs the user to run `claimrail check --allow-net`") instead of hard-writing precedent and getting blocked on every delivery.

## 4. You must pass the gate before delivering

```
claimrail check            # inside this repo: node src/cli.mjs check
```

- `✓ 可以交付` (exit 0): continue.
- `✗ 交付被拦住（block）`: **ask the user about the listed forks before doing anything else**, all at once, not in three rounds. The questions are the `evidence: null` entries.
- `✗ 交付被拦住（halt）`: unattended, high cost, no evidence. Stop and report where you're stuck; do not "build the common version now and revisit later".
- Ledger structurally invalid: fix the declaration first, nothing else needs to run.
- Run `check` at most twice; if the second run still blocks, stop and ask everything in one go — don't keep grinding.

## 5. Frontend changes

```
claimrail web --url http://localhost:5173/chat --state .claimrail/storage.json
```

Multiple viewports are the default (390×700 and 1280×800) — defects like an overlay scrollbar covering text only show up on narrow screens, so running wide-only means letting them through.

The five checks: **scrollbar clears text** (scrollbar-clears-text), **touch targets** (touch-targets-ok), **contrast** (contrast-ok), **focus visible** (focus-visible-ok), **bottom bar not covered** (bottom-not-covered). A `null` in the report means "not judged", not "fine"; copy only the ids that actually went green into `asserts`.

If the page won't load, or needs a login you don't have: **never skip silently**. State in your delivery notes "I could not visually verify this item, because X" and run whatever you can.

The output ends with a paste-ready `evidence` line whose `asserts` contain only checks the program passed. Copy it verbatim, don't write your own — turning `null` (undecided) into "verified" is the one thing this mechanism must never do.

## 6. After the user rejects something

```
claimrail record --key card-gap --what "card vertical gap at least 16px" --why "too cramped"
```

A key must be hit twice before it becomes a rule; `claimrail invalidate <key>` retracts a rule, and the raw log stays untouched (the log is truth, rules are cache).

When the user says "not this", record **what they want** (`--what`), not their complaint verbatim. Run `claimrail rules` before your next change.

`--anchor` records a **reference** (positive example): when the user points at something to imitate ("follow our repo's convention"). It never becomes a rule — its use is naming it next time ("do it like reference log#n"), listed separately in `claimrail rules`.

## Never do this

- Never fill `evidence` with something that looks verifiable but was never run — all five kinds are re-checked by the program. `precedent` is checked hardest: domains are deduplicated and every quote is compared against the page.
- Never treat `forks: []` as the default answer.
- Never reword the ledger to get past a block; get evidence or ask a human.
