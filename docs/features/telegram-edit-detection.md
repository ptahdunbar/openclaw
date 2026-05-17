# [Feature]: Telegram `edited_message` agent notification

> Drafted against the upstream feature request template.

---

## Summary

Add agent-aware handling for Telegram `edited_message` events so agents are notified when a user edits a message they previously responded to, and can optionally re-process or acknowledge the change.

---

## Problem to solve

When a user edits a Telegram message, OpenClaw agents have no awareness of the change. The gateway already receives `edited_message` updates from Telegram (the event is in `allowed_updates`) but the handler only calls `recordMessageForReplyChain()` — updating thread context — without notifying or re-triggering the agent session.

**Current behavior:**
1. Agent responds to user message with text "X"
2. User edits the message to "Y"
3. Agent's response still references "X"
4. User sees a stale, incorrect reply with no correction path short of manually re-sending

**Why current behavior is insufficient:**

- **Silent drift** — the agent's response references content the user has already corrected. No signal that the state is stale.
- **No recovery mechanism** — the only workaround is for the user to send a new message saying "edit to previous: [change]", which is undiscoverable and pollutes history.
- **Agentic workflow risk** — in multi-step tasks (booking, form filling, data entry), a silently-ignored edit causes downstream actions to execute against incorrect input.

**Confirmed source gap** (`extensions/telegram/src/bot-handlers.runtime.ts:2673`):

```typescript
bot.on("edited_message", async (ctx) => {
  const msg = ctx.editedMessage;
  if (!msg) return;
  await recordEditedMessageForReplyChain(ctx, msg);  // reply chain only — no agent notification
});
```

`recordEditedMessageForReplyChain` → `recordMessageForReplyChain` updates thread metadata only. It never calls `handleInboundMessageLike` or any session injection path.

---

## Proposed solution

Add configurable edit-event handling via a new `editedMessages` config field under `channels.telegram`:

### Modes

**`notify`** (recommended default)
Inject a system event into the session when an edit is detected on a message the agent previously replied to:
```
[system] User edited message {id}: "{new_text}"
```
Agent decides what to do based on its own persona/prompt config.

**`prompt`**
Send a lightweight reply to the user:
> "I see you updated that — want me to re-answer with the change?"

With inline buttons: **Re-answer / Ignore / Don't ask again**

**`reprocess`**
Treat the edited message as a new agent turn. Re-run the agent with the updated text. Apply a configurable cooldown window (`reprocessWindowSec`, default `60`) to skip re-runs after the conversation has moved past the edit.

**`ignore`** (current behavior / default)
Silently ignore edits. Preserves existing behavior. Opt-out path.

### Config schema

```json
{
  "channels": {
    "telegram": {
      "editedMessages": {
        "mode": "notify" | "prompt" | "reprocess" | "ignore",
        "reprocessWindowSec": 60,
        "onlyIfAgentReplied": true
      }
    }
  }
}
```

### Implementation surface

- Extend `bot.on("edited_message", ...)` handler in `extensions/telegram/src/bot-handlers.runtime.ts`
- `onlyIfAgentReplied: true` (default) — only fire when the session has a prior reply to this `message_id`
- `edit_date` from the Telegram update used for the `reprocessWindowSec` calculation
- No changes to `allowed_updates` needed — event already arrives

---

## Alternatives considered

**1. Re-process all edits unconditionally**
Rejected. Typo corrections after the conversation has moved on trigger unnecessary (and expensive) agent re-runs. No way to distinguish "user fixed a typo" from "user changed their request."

**2. Diff storage + context injection**
Store original message text at send time; on edit, compute diff and inject both into context (e.g., "changed: 'X' → 'Y'").

Deferred to v2. Correct long-term direction but requires a persistent message store (new infra surface). Can layer on top of `notify` mode once the base hook exists.

**3. Status quo + documentation**
Rejected as end state. Already documented as a known limitation with a workaround. Doesn't scale for agentic workflows where edits have real consequences.

---

## Impact

- **Affected:** All Telegram users of OpenClaw agents in DM and group/forum channels
- **Severity:** Medium — silent incorrect state; doesn't crash but causes wrong behavior
- **Frequency:** Common — users routinely edit messages to correct typos or clarify intent
- **Consequence:**
  - Stale agent responses visible to user with no self-correction
  - In multi-step agentic tasks: downstream actions execute against incorrect input
  - Extra manual round-trips (+1–2 messages) to recover correct state

---

## Evidence / examples

**Telegram Bot API:** Bots receive `edited_message` + `edited_channel_post` update types. Both `message_id` (original) and `edit_date` (Unix timestamp) are present. No original text is provided — only current state. [Docs](https://core.telegram.org/bots/api#update)

**Source confirmed:** Event is already handled (`bot-handlers.runtime.ts:2673`) and already in `allowed_updates` (`bot-updates.ts:22`). The gap is purely in what the handler does with it — not whether it arrives.

**User-reported workaround:** "send a new message saying 'edit to previous: [change]'" — confirms the friction is real and known.

---

## Additional information

- Backward compatible: default to `ignore` to preserve existing behavior
- `onlyIfAgentReplied: true` should default on — avoids firing on edits to messages the agent never saw
- Upstream PR candidate once implementation is clean and tested in fork
- Related fork branch: `feat/telegram-forum-topic-names`
