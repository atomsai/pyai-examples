# PyAI webhook receiver

Requires Node.js 22+. No dependencies.

Copy `.env.example` to `.env` and set your organization webhook signing secret. Run `npm start`. Expose port 8080 over HTTPS and configure `/webhooks/pyai` as the callback URL. `npm test` checks signature verification.

Verified events are saved in `inbox/` before a 204 response. This is a local development receiver: for production use a durable queue/store, event-specific deduplication, monitoring and a retention policy. The inbox can contain transcripts; keep it private.

[Webhook contracts and configuration](https://pyai.com/webhooks.md).
