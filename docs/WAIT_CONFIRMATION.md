# Confirmation reminders and stability boundaries

This workflow addresses a specific gap: a native dot tool call can pause for upload/action approval before the caller has another chance to send a Feishu update. The bridge does not receive that native request. Do not describe this candidate as automatically capturing all dot approvals or permanently eliminating missed reminders.

## What the bridge knows

The [official MCP Events documentation](https://developers.openai.com/plugins/build/mcp-events) describes events sent **from an MCP server to ChatGPT**, acknowledged asynchronously. It is not a reverse feed of every native dot permission request. The [dot controls documentation](https://learn.chatgpt.com/docs/dots/controls) places actual decisions in the original Activity request. The [Responses API MCP approval flow](https://developers.openai.com/api/docs/guides/tools-connectors-mcp#approvals) belongs to API responses controlled by that API client; it is not a personal-dot subscription. Codex app-server approval requests likewise belong to the client controlling that Codex runtime. No verified adapter for this personal dot's native approvals is configured here.

Never synthesize an approval event, poll an unsupported private endpoint, scrape unrelated task histories, bypass approval, or treat a Feishu click as permission. The fixed navigation URL is `https://chatgpt.com/dots/home`, not an account/task-specific approval link.

## Before an external action that may pause

Use the existing status tool **before** calling the protected external tool:

```text
submit_feishu_status({
  binding_id:B, task_id:OBSERVED_TASK, request_id:STABLE_STEP_NOTICE,
  expected_revision:R, status:"processing",
  confirmation_notice:"before_action",
  summary:"Preparing the requested external action",
  action:"Attempt the requested upload", reason:"dot may require confirmation",
  existing_user_authorization:true
}) -> output_id:O
output_delivery_status({output_id:O})
```

The prospective card is labeled **行动前提示 / pre-action notice**. It states that a confirmation *may* appear and no approval request is yet established, provides official navigation and says clicks grant no permission. It creates a new important card, even when that task has an older accepted progress card. Action and reason are mandatory; this option is valid only with `processing`.

A caller/adapter must wait for `state=sent`, `api_accepted=true` and the recorded message receipt before moving to the protected step. Queue acceptance is insufficient. If the notice is failed, blocked, cancelled or uncertain, stop and reconcile; do not substitute a new request ID or proceed while claiming the user was informed. If the bridge tool itself is blocked/cancelled before reservation, there may be no Feishu notice; the original dot request remains the fallback. An interrupted call with no returned ID requires proof of the exact reservation's presence/absence before retrying; silence is not proof that nothing was sent.

This ordering is operational protection, **not an interception of arbitrary native tools**. The bridge cannot force unrelated GitHub/app tools to call it, control native approval timing, or guarantee client display. Unanticipated native approvals, omitted preflights and platform pauses before the preflight still require checking dot Activity. Instructions alone are not a durable enforcement mechanism.

## When an actual wait has been observed

For a current Feishu input with a live handling claim, record the wait and its explicitly authorized notification in one call:

```text
complete_event_handling({
  event_id:E, revision:C, outcome:"waiting_authorization",
  notice:{summary:"This task is waiting for your decision",
          action:"Review the actual request in dot Activity",
          reason:"The observed action requires confirmation",
          existing_user_authorization:true}
}) -> waiting_notification:{output_id:O, task_id:T, state:"pending", ...}
output_delivery_status({output_id:O}) -> inspect the actual receipt
get_event_handling({event_id:E}) -> inspect waiting_notification
```

The bridge validates the current event identity and live revision, then atomically persists the handling decision and reserves a new waiting card. A storage failure rolls back both. The reservation identity is derived from the event and claim revision; callers cannot invent another notice request ID to force replay. Identical retries reuse the same row, changed notice bodies conflict, and ambiguous/in-flight sends become `uncertain` without replay. This uses schema5's existing handling/outbox tables; no migration or historical backfill is introduced.

The `event_wait_` identity namespace is internal. Public image sends and status requests cannot use it to fabricate linked notices. After the initial linked card is actually accepted, callers can explicitly submit an ordinary processing/completion/failure update to its returned `task_id` and observed output revision using a new stable, non-reserved request ID. This PATCHes that card; another distinct real wait uses a new observed handling claim revision.

Callers must have real authorization to send the notice and must actually observe the wait. The assertion is not an approval grant. Incoming message content cannot provide permission. If sending is prohibited, omit `notice`: the old no-send wait remains supported, and `get_event_handling`/`list_event_alerts` expose `waiting_notification.state=not_submitted` with `requires_attention=true`. No notification is silently invented from old waits or at startup. Non-event tasks still use `submit_feishu_status` explicitly.

To resume, verify real approval in the original dot request, then use the existing explicit `resume_waiting:"existing_user_authorization"` claim. A clicked card, accepted notice or new Feishu text cannot approve the native request. Resume itself sends nothing. Optional subsequent card updates remain separate authorized sends and do not close input coverage or prove approval.

## Failure and recovery checklist

- Check each input's handling and actual text-reply state, each staged/generated image's upload **and** message receipt, and every card's exact output state. Scan all event/output alert pages, including empty filtered pages, and rescan from zero at task end.
- Persisted pending notices may make their first attempt after restart within the original binding/access lifetime. Interrupted `sending` notices recover as uncertain; sent/uncertain notices do not replay. Restart cannot manufacture a native approval event.
- Callback delivery has separate bounded retry/recovery with stable event IDs. Callback acceptance does not prove processing or a reply. Replies, images and cards keep their own durable reservations.
- Rebinding, revocation, principal expiry, stale revisions and lease expiry fail closed. Do not replay old pending business already answered elsewhere, and do not run an old schema4 snapshot over schema5 reservations.
- Decoder and transport tests use synthetic bytes and local/mock services. Real historical receipts can corroborate earlier accepted text/image/card paths, but cannot certify continuous uptime, all clients or a newly changed workflow.

## Installation review

The tool count stays unchanged: 16 default, 17 with input, 18 with output, 19 with both. The optional schemas and descriptions changed, so inspect the actual refreshed tool catalog before use; do not assume a product UI count proves schema refresh. Preserve the installed private networking and configuration outside public commits. No new permissions or callback-approval feature are introduced. Review this candidate, run the complete Linux suite and take a consistent backup before any separately approved rollout.

No production restart, forced disconnect, new real send or deployment is needed for the isolated tests. A future controlled live restart would temporarily interrupt bridge intake/MCP calls and may lose ephemeral inbound image references; durable jobs and reservations must be preserved, only one worker restarted, and the original Tunnel/configuration restored unchanged. Such a rehearsal requires its own timing/impact review. It would still not prove recovery of events never persisted during an outage.
