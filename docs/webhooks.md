# Webhook Delivery

OrbitStream delivers events to your configured `webhook_url` through a Redis-backed
delivery queue with prioritisation, automatic retries, strict per-session ordering,
and a dead-letter queue for deliveries that cannot be completed.

## Events & priority

Events are delivered highest-priority first:

| Event               | Priority |
| ------------------- | -------- |
| `payment.confirmed` | 1 (highest) |
| `session.expired`   | 2 |
| `payment.failed`    | 2 |
| `session.created`   | 3 |
| `session.cancelled` | 3 |

## Request format

Each delivery is an HTTP `POST` with a JSON body and the following headers:

| Header                      | Description |
| --------------------------- | ----------- |
| `X-OrbitStream-Event`       | The event name. |
| `X-OrbitStream-Delivery-Id` | UUID v4 — **stable across retries** of the same delivery. |
| `X-OrbitStream-Timestamp`   | ISO 8601 timestamp, fixed at enqueue time. |
| `X-OrbitStream-Sequence`    | Per-session ordering sequence number. |
| `X-OrbitStream-Signature`   | `sha256=<hex HMAC>` (see below). |

Body:

```json
{
  "event": "payment.confirmed",
  "data": { "sessionId": "…", "txHash": "…", "amount": "10.0", "asset": "XLM", "sender": "G…" },
  "timestamp": "2026-06-19T00:00:00.000Z"
}
```

## Verifying the signature

The signature is an HMAC-SHA256 over `delivery_id + "." + timestamp + "." + raw_body`,
keyed with your `webhook_secret`:

```js
import crypto from 'crypto';

function verify(req, secret) {
  const deliveryId = req.headers['x-orbitstream-delivery-id'];
  const timestamp = req.headers['x-orbitstream-timestamp'];
  const signature = req.headers['x-orbitstream-signature']; // "sha256=…"
  const signed = `${deliveryId}.${timestamp}.${req.rawBody}`;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(signed).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

Always compare with a constant-time function and use the **raw** request body.

## Idempotency

Webhooks are delivered **at least once** — a retry can arrive after your endpoint has
already processed an event (e.g. you returned `200` but the connection dropped).

To deduplicate, **store every `X-OrbitStream-Delivery-Id` you have processed and ignore
repeats.** The delivery id is stable for the lifetime of a delivery, including all
retries, so it is a safe idempotency key:

```js
if (await seenDelivery(deliveryId)) return res.sendStatus(200); // already handled
await markDelivery(deliveryId);
await handleEvent(body);
return res.sendStatus(200);
```

## Retries & backoff

A delivery is retried with exponential backoff plus ±20% jitter:

`1 min → 5 min → 30 min → 2 hr → 12 hr`, up to **5 attempts**.

Outcome by response:

- **2xx** — success.
- **4xx** (except `408`/`429`) — endpoint is considered broken; the delivery is
  **dead-lettered immediately** (no retries).
- **408 / 429 / 5xx / network errors / timeouts** — retried with backoff.

The per-attempt HTTP timeout is 10 seconds. After 5 failed attempts a delivery is
moved to the dead-letter queue.

## Ordering

Webhooks for the **same checkout session** are delivered strictly in order. A later
event for a session is never delivered until the earlier one has either succeeded or
been dead-lettered — even while the earlier one is mid-retry. Events for different
sessions are delivered concurrently.

## Dead-letter queue & management API

All endpoints are JWT-authenticated (merchant dashboard) and scoped to the
authenticated merchant.

| Method & path                              | Description |
| ------------------------------------------ | ----------- |
| `GET /v1/webhooks/deliveries`              | Recent delivery records (`?limit=` optional). |
| `GET /v1/webhooks/dead-letter`             | Dead-letter entries (payload, full attempt history, reason). |
| `POST /v1/webhooks/dead-letter/:id/retry`  | Re-enqueue a dead-letter entry as a fresh delivery. |
| `DELETE /v1/webhooks/dead-letter/:id`      | Dismiss a dead-letter entry. |
