---
name: send-teams-notification
description: >-
  Send an explicitly requested or preauthorized message to a configured Teams
  channel as Workflows (Flow bot), optionally mentioning a user. Use for task
  updates, results, PR links, alerts or other approved text, not only evidence
  work. Uses the authenticated sender and durable no-retry delivery receipts.
---

# Send a Teams channel notification

This is a reusable messaging utility, not a collector, reviewer, worker or
scheduler. Any agent/session with the required authorization can use it.
Loading the skill does not authorize a message or grant Azure permissions.
Do not spawn another agent to send a message.

## Inputs and prerequisites

- The message or workflow event the user authorized for channel publication.
- The periodic-evidence-agent repository root containing `package.json` and
  its `notify:teams` command.
  When using this repository's skill, it is three directory levels above this
  skill directory. Resolve paths from that root, not from a product checkout.
- An approved, gitignored `teams.local.json`, or an explicitly selected
  `*.local.json` configuration. Read the configured destination before sending.
  Do not infer a different destination from channel names in message content.
- A stable notification ID matching `[A-Za-z0-9_-]{1,100}`, derived from the
  source task/run and event. Reuse it for the same event across sessions.
- Optional mention: the recipient's verified Entra user object ID and display
  name. Resolve "me" through the authenticated user's identity; never guess an
  ID or create a fake mention by inserting ordinary `@name` text.

Node.js 24+, this repository's locked dependencies and an authorized Azure CLI
sign-in are required. The deployed workflow must use Flow bot, the configured
channel, narrow Entra OAuth policies, SAS disabled and connector retries
disabled. See [sender setup](../../../README.md#explicit-teams-notifications).
Do not deploy or change a workflow just because a message was requested.

The actual sender is **Workflows (Flow bot)**, not the invoking user or a
dedicated bot named after the source agent. Cards currently use the heading
**Periodic Evidence Agent**; include the originating task/agent in the message
when that context matters.

## Procedure

1. Confirm that this content and destination are within the user's request or
   an existing explicit workflow authorization. Do not expand the audience,
   publish raw private evidence, or include credentials, tokens or callback
   URLs. Respect any stricter role/host publication restrictions.
2. Select the repository's approved `teams.local.json` and stable notification
   ID. Resolve the shared notification directory from that configuration's
   `stateDirectory`, relative to the configuration directory when not absolute;
   the default is `.state\teams-notifications`. Use
   `<shared-directory>\<ID>.message.json` and
   `<shared-directory>\<ID>.receipt.json` for every session.
   Check for an existing receipt **before** creating or changing inputs.
3. If a receipt already exists, do not invoke the sender again. `sent` means a
   connector-confirmed send; report its message ID. `sending` or `unknown`
   requires reconciliation with the workflow run and destination channel.
   Never delete a receipt, change the ID, use another receipt directory, or
   switch to a user-account sender to bypass an uncertain delivery.
4. Write the message JSON to the canonical input path using the host's normal
   file-editing tool. Include `test: true` only for a requested test. `text`
   accepts 1 through 4000 characters and can include task or PR links. Summarize
   longer content instead of automatically splitting it into multiple posts.
   File uploads, arbitrary card JSON and multiple mentions are not supported
   by this sender.

   ```json
   {
     "id": "TASK_ID-complete",
     "text": "Source: task name. Result: approved summary and relevant links.",
     "mention": { "id": "VERIFIED_USER_GUID", "name": "Display name" }
   }
   ```

   Omit `mention` when none was requested. Do not add an @mention by default.
5. Run the repository command once from the periodic-evidence-agent root.
   In PowerShell:

   ```powershell
   Set-Location -LiteralPath $PilotRoot
   npm run notify:teams -- --message "$MessagePath"
   ```

   The command defaults to the repository's `teams.local.json`. Pass
   `--config "$ConfigPath"` only when another approved configuration was
   explicitly selected. Let the command derive the canonical receipt from that
   configuration and notification ID; do not pass a new `--receipt` path.
   The helper verifies the designated Azure identity and deployed destination,
   obtains an ARM bearer token without exporting it, and reserves the receipt
   before its single outbound POST. It does not schedule subsequent messages.
6. Read the saved receipt. When a native Teams/WorkIQ read tool is available,
   fetch the exact returned message from the configured team/channel and
   confirm the card and requested mention. Do not send another test merely to
   verify skill discovery or compensate for a read failure.

## Results and blockers

Return the configured destination, notification ID, receipt path and message
ID. Distinguish connector-confirmed delivery from an independently read-back
message; neither proves a toast notification appeared or a person read it.
Do not claim a message was sent when the helper failed or returned no confirmed
message ID.

On authentication, permission, identity or destination mismatch, stop and report
the blocker. Do not widen OAuth/RBAC, change the designated user, copy credentials
from another session, request a pasted token, redeploy, or fall back to another
transport. Another human operator needs their own separately approved identity,
Azure permissions and local configuration; the skill itself is not that grant.

On `notification-unconfirmed`, preserve the receipt and any workflow run ID.
Reconcile the existing run/message before any separately authorized follow-up;
there is no automatic retry or exactly-once server guarantee. All callers must
share the same repository state and canonical receipt path for the same event.

## Availability

In a checkout containing this skill, ask the host to use
`send-teams-notification`. Reload/reopen if project skills have not refreshed.
For another repository/session, add this notification checkout as an allowed
directory with `/add-dir <notification-checkout>` and pass explicit root/config
paths. Loading the skill alone without its sender, dependencies, private
configuration and shared receipts is insufficient. No global skill installation
or permission change is implied.

The skill and sender belong to the versioned periodic-evidence-agent repository,
not a per-session directory. Use the team's normal checkout and repository-local
configuration. A different checkout sharing the deployment must point its
private `stateDirectory` at the same durable receipts instead of silently
creating a new per-session history.
