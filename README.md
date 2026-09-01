# PR Pro

A custom workflow for [expecto-centum](https://www.expectocentum.com).
It reviews the open pull requests in your repositories and posts what it
finds as a comment on each one.

Six stages, each with a live implementation and a Test-mode twin:

| Stage | What it does |
|---|---|
| **PR Scan** | Lists the open, non-draft PRs in the repos you pick and mints one review ticket per PR. Narrows by author and by date. |
| **Discussion** | Reads the comments already on the PR, so the review builds on the discussion it is joining. |
| **Correctness** | An adversarial verifier pass: runs the repo's own checks, hunts for bugs, attacks trust boundaries, judges test discipline. |
| **Quality** | The lenses correctness doesn't cover — duplication, maintainability, freeze/crash robustness. |
| **Evidence** | Verifies every finding from both reviews against the code and throws out what can't be shown. Captures before/after screenshots for UI changes. |
| **Publish** | Shows you the comment about to be posted, then posts it to the PR thread on your confirmation. |

Works against GitHub, GitLab, and Bitbucket. The provider is resolved from
each repo folder's own git remotes at call time, and the app attaches the
credential — no stage in this workflow ever holds a token.

## Install

Clone it wherever you keep repositories:

```sh
git clone https://github.com/alfonsocejudo/pr-pro.git
```

Then in the app, open **Add New Workflow** at the bottom of the workflow
dropdown (or **Add workflow** in Config → Workflow) and switch to its
**Import** tab. Choose that folder, and pick **Link to it where it is**.
Linking means a `git pull` here updates the workflow in the app — which
is what you want for a workflow distributed as a repo. **Copy it in** is
the other option: a snapshot that stops tracking this folder, so updating
means importing again.

Either way it installs as `pr-pro` — the name comes from `workflow.json`,
not from whatever the folder is called, so an archive that unpacks as
`pr-pro-main` still lands correctly.

On an app without the Import tab, put the folder in your workflows
directory yourself — `~/expecto-centum/workflows/pr-pro` unless you've
changed the location in Config → General. A symlink there works the same
as a copy.

**You'll be asked to approve it before the first run.** A workflow you got
from someone else is code that runs on your machine with your files, your
network, and your saved sign-ins, so the app blocks it until you've
approved that folder's exact contents — importing never approves anything
on your behalf. Editing any file drops the approval and re-prompts, and so
does pulling an update into a linked folder. Read the stage files first —
that's the point of the gate.

## Configure

1. **Connections tab** — connect the GitHub, GitLab, or Bitbucket account
   that will read the PRs and post the comments.
2. **General → Local repositories** — add each repo you want reviewed, with
   a local path and that account bound as its "Publish to".
3. **PR Scan's Settings** (the gear above the machine) — pick the
   **Repositories to scan**. Optionally narrow to **Only these authors**
   (comma-separated usernames) or by date (**Updated in the last N
   days**, or fixed **Updated on or after** / **Updated on or before**).
   A reviewed PR comes back on its own only when new commits land; tick
   **Include already-reviewed pull requests** to re-queue PRs already
   reviewed at their current commit — for a second look after the author
   replied in the discussion, for instance.
4. **Per-stage agents** — Correctness, Quality, and Evidence each drive a
   CLI agent. Pick one per stage on the dashboard.

## Try it without spending anything

Every stage has a fixture twin, so Test mode runs the whole pipeline with
no LLM calls and no provider calls — canned PRs, a canned discussion,
canned reports, and two stand-in screenshots. The Publish preview dialog
is the real one, so you can see exactly what would be posted.

## How the review is split

The three review stages have deliberately separate scopes, and each one
reads the reports before it:

- **Correctness** owns executable checks, bug hunting, adversarial
  security, and test discipline.
- **Quality** owns duplication, maintainability, and hang/crash
  robustness, and sees the correctness report.
- **Evidence** verifies both. Every claim needs its receipt — the failing
  command re-run, the cited lines confirmed, the failure scenario
  reproduced. Whatever can't be shown is dropped and listed under "Did
  not reproduce."

Each review stage opens its report with a verdict on its own line, which
its machine artwork reacts to. `stages/review-verdict.ts` is the shared
parser.

## Notes for anyone adapting this

- `stages/machine-pacing.ts`, `review-verdict.ts`, and `review-preview.ts`
  are shared helpers, not stages — `workflow.json` never names them. The
  editor writes a machine's starter to `stages/<machineId>.ts`, so keep
  helper filenames clear of any machine id.
- Each stage's `stages/<id>.svg` is its machine artwork. The stage code
  sets state names with `ctx.machine.setState()`; the SVG reacts with
  `[data-machine-state="..."]` CSS. State names are yours, and the artwork
  ignores one it has no rule for.
- `stage-types.d.ts` is written by the app next to `workflow.json` — by
  the scaffolder when a folder is created, and again on every save from the
  in-app editor, so it always matches the running app. It's committed here
  so the repo gives you IntelliSense straight out of a clone.
- Every import of it is type-only, so the stage files stay
  runtime-self-contained.
- The review prompts defer to the reviewed repo's own engineering
  referents — a threat model, a definition of done, a gate registry — so
  the workflow adapts to each repo's standards.
- Publish and Evidence each ship a recovery action, surfaced as a
  one-click button when a ticket parks at Attention.

## License

MIT — see [LICENSE](LICENSE).
