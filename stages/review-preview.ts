// Shared preview gate for the Publish stage's live + fixture twins — the
// dialog loop that shows the review about to be posted (Formatted /
// Edit toggle) and waits for the operator's Post review or
// Cancel-with-reason. The Edit view is the text that gets posted, so the
// operator can cut a paragraph the run didn't need to say without
// abandoning the ticket. One module so the two twins can't drift apart
// on dialog copy, edit semantics, or cancel semantics. Not a stage —
// the manifest never names this file.
//
// Type-only import — erased when the module loads; stage-types.d.ts
// (app-written, next to workflow.json) carries the contract.
import type {
  MachineHandle,
  StageContext,
  StageOutcome,
  Ticket,
  WorkflowState,
} from "../stage-types";

/** One validated capture on `state.reviewScreenshots` — written by the
 *  Evidence stage, read by the Publish preview + upload. Exported so the
 *  two stages type the same record; the import is type-only, so no
 *  runtime coupling rides along. */
export interface ReviewShot {
  file: string;
  phase: "before" | "after";
  caption?: string;
  /** Server-relative path a dialog Image node loads this capture from. */
  apiPath: string;
}

/** The Evidence stage's validated screenshot list off `state`, or [] when
 *  it carries none (recovery path, no UI change, older run). Shared by the
 *  Publish twins so live upload and Test preview read the same record. */
export function readScreenshots(state: WorkflowState): { dir: string; shots: ReviewShot[] } {
  const rec = state.reviewScreenshots as { dir?: unknown; shots?: unknown } | undefined;
  if (!rec || typeof rec !== "object" || !Array.isArray(rec.shots)) return { dir: "", shots: [] };
  return { dir: typeof rec.dir === "string" ? rec.dir : "", shots: rec.shots as ReviewShot[] };
}

/** One node of a dialog body — the shape `dialog-open` specs carry. */
interface DialogNode {
  component: string;
  props?: Record<string, unknown>;
  children?: DialogNode[];
}

interface DialogSpec {
  id: string;
  title: string;
  description?: string;
  body: DialogNode;
  buttons: Array<{ id: string; label: string; variant?: string; commit?: boolean }>;
}

/** Open one dialog spec on this stage's machine and await the operator's
 *  `{ action, fields }` answer. A dismissal (esc, overlay click) comes
 *  back as action "". */
async function openDialog(
  machine: MachineHandle,
  spec: DialogSpec,
): Promise<{ action: string; fields: Record<string, string> }> {
  machine.trigger("dialog-open", { spec });
  const raw = await machine.waitFor("dialog-result");
  const action = raw && typeof raw.action === "string" ? raw.action : "";
  const fields: Record<string, string> = {};
  if (raw && raw.fields && typeof raw.fields === "object" && !Array.isArray(raw.fields)) {
    for (const [k, v] of Object.entries(raw.fields)) {
      if (typeof v === "string") fields[k] = v;
    }
  }
  return { action, fields };
}

/** Field id carrying whether shot `index` rides along on the comment. */
function shotFieldId(index: number): string {
  return `shot-${index}`;
}

/** The caption under a shot — its phase, plus whatever the Evidence
 *  stage recorded about it. */
function shotLabel(s: ReviewShot): string {
  return `${s.phase === "before" ? "Before" : "After"}${s.caption ? ` — ${s.caption}` : ""}`;
}

/** Screenshot figures for the preview — the same evidence images the
 *  Publish stage uploads to the PR, loaded off the run's evidence store
 *  via each shot's `apiPath`. Each one carries a checkbox holding its
 *  caption: a shot the operator unchecks stays out of the comment and is
 *  never uploaded. */
function screenshotNodes(shots: readonly ReviewShot[]): DialogNode[] {
  if (!shots || shots.length === 0) return [];
  return [
    {
      component: "Section",
      props: { title: "Screenshots", subtitle: "Uncheck any that shouldn't ride along." },
      children: shots.map((s, i) => ({
        component: "Stack",
        props: { direction: "col", gap: "xs" },
        children: [
          {
            component: "Checkbox",
            props: { fieldId: shotFieldId(i), label: shotLabel(s), default: true },
          },
          { component: "Image", props: { src: s.apiPath, alt: shotLabel(s) } },
        ],
      })),
    },
  ];
}

/** The shots the operator left checked. A field the harvest doesn't
 *  carry means the checkbox never registered, so the shot rides along —
 *  the Evidence stage put it there and nothing said to drop it. */
function keptShots(
  shots: readonly ReviewShot[],
  fields: Record<string, string>,
): ReviewShot[] {
  return shots.filter((_, i) => (fields[shotFieldId(i)] ?? "true") === "true");
}

/**
 * Wire prefix for the filter reason an operator's cancel produces —
 * `publish:preview-cancelled:<slug>`, the shape the app's filter-reason
 * classifier matches to bucket a cancel as an operator decision rather
 * than a triage verdict. A stage file can't import the app's constant, so
 * the string is duplicated here; it has to stay in step with
 * `PUBLISH_PREVIEW_CANCEL_PREFIX`.
 *
 * `other` is the slug: this dialog collects free text rather than one of
 * the app's `wrong-branch` / `bad-code` choices, so no narrower slug
 * would be honest.
 */
const CANCEL_REASON = "publish:preview-cancelled:other";

/** Field the edited review lives under — the Textarea owns it, the
 *  Formatted view renders it, and the harvest returns it to the gate. */
const REVIEW_FIELD = "review";

/** The preview dialog: the comment about to be posted, as either rendered
 *  markdown or an editable source view (`When` gates on the RadioGroup's
 *  field). The Textarea is the single source of truth for what posts —
 *  it stays mounted behind the closed gate (`keepMounted`) so switching
 *  views keeps the operator's edits, and the Formatted view reads its
 *  live value through `fromField` rather than the original text. */
function buildPreviewSpec(ticket: Ticket, review: string, shots: readonly ReviewShot[]): DialogSpec {
  return {
    id: "review-preview",
    title: `Post review to ${ticket.key}?`,
    description:
      "This comment is posted to the pull request thread exactly as shown. Switch to Edit to change it first.",
    body: {
      component: "Stack",
      children: [
        {
          component: "RadioGroup",
          props: {
            fieldId: "view",
            variant: "segmented",
            options: [
              { value: "formatted", label: "Formatted" },
              { value: "edit", label: "Edit" },
            ],
          },
        },
        {
          component: "When",
          props: { field: "view", equals: "formatted" },
          children: [
            {
              component: "Scroll",
              props: { maxHeight: "50vh" },
              children: [
                {
                  component: "Markdown",
                  props: { text: review, fromField: REVIEW_FIELD, baseUrl: ticket.sourceUrl },
                },
              ],
            },
          ],
        },
        {
          component: "When",
          props: { field: "view", equals: "edit", keepMounted: true },
          children: [
            {
              component: "Scroll",
              props: { maxHeight: "50vh" },
              children: [
                {
                  component: "Textarea",
                  props: {
                    fieldId: REVIEW_FIELD,
                    default: review,
                    rows: 24,
                    monospace: true,
                    required: true,
                    requiredMessage: "The review can't be posted empty — cancel instead.",
                  },
                },
              ],
            },
          ],
        },
        ...screenshotNodes(shots),
      ],
    },
    buttons: [
      { id: "post", label: "Post review", variant: "primary", commit: true },
      { id: "cancel", label: "Cancel", variant: "secondary" },
    ],
  };
}

/** The cancel-reason dialog. Back reopens the preview. */
const CANCEL_SPEC: DialogSpec = {
  id: "review-cancel-reason",
  title: "Cancel posting",
  body: {
    component: "Stack",
    children: [
      {
        component: "Text",
        props: { text: "The review is not posted. An optional reason lands in the run summary." },
      },
      { component: "Textarea", props: { fieldId: "reason", label: "Reason" } },
    ],
  },
  buttons: [
    { id: "back", label: "Back", variant: "secondary" },
    { id: "submit", label: "Confirm cancel", variant: "destructive", commit: true },
  ],
};

/** What the operator settled on: the review text to post — their edit
 *  when they made one, the stage's own text otherwise — plus the
 *  screenshots they left checked, or the filter outcome the stage
 *  returns instead. */
export type PreviewDecision =
  | { readonly confirmed: true; readonly review: string; readonly shots: ReviewShot[] }
  | { readonly confirmed: false; readonly outcome: StageOutcome };

/** Drive the preview ↔ cancel-reason loop until the operator confirms
 *  posting, cancels, or dismisses. */
export async function runPreviewGate(
  ctx: StageContext,
  ticket: Ticket,
  review: string,
  shots: readonly ReviewShot[],
): Promise<PreviewDecision> {
  for (;;) {
    ctx.log("Waiting for the operator to confirm posting…");
    const preview = await openDialog(ctx.machine, buildPreviewSpec(ticket, review, shots));
    if (preview.action === "post") {
      // The dialog's `required` gate rejects an empty edit before the
      // action posts, so a blank field here means the Textarea never
      // registered — the renderer degraded the spec. The stage's own
      // text stands in, keeping an empty comment off the PR.
      const edited = (preview.fields[REVIEW_FIELD] ?? "").trim();
      const kept = keptShots(shots, preview.fields);
      if (kept.length < shots.length) {
        ctx.log(`Dropping ${shots.length - kept.length} of ${shots.length} screenshots.`);
      }
      if (edited.length > 0 && edited !== review.trim()) {
        ctx.log("Posting the operator's edited review.");
        return { confirmed: true, review: edited, shots: kept };
      }
      return { confirmed: true, review, shots: kept };
    }
    if (preview.action !== "cancel") {
      // Dismissal is terminal — the operator already opted out of the
      // dialog UI, so no follow-up reason form.
      ctx.log("Posting cancelled by operator.", "warn");
      return {
        confirmed: false,
        outcome: {
          status: "filter",
          reason: CANCEL_REASON,
          message: "Posting cancelled by operator.",
        },
      };
    }
    const cancel = await openDialog(ctx.machine, CANCEL_SPEC);
    if (cancel.action === "back") continue;
    const detail = (cancel.fields.reason ?? "").trim();
    const message = detail
      ? `Posting cancelled by operator: ${detail}`
      : "Posting cancelled by operator.";
    ctx.log(message, "warn");
    return {
      confirmed: false,
      outcome: { status: "filter", reason: CANCEL_REASON, message },
    };
  }
}
