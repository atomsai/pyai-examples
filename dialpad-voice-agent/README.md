# Dialpad after-hours voice agent

Keep your Dialpad numbers and human team. This server verifies a Dialpad call-router callback and sends selected calls to an **existing PyAI agent phone number**. During business hours it returns a Dialpad human destination. After hours it returns the PyAI destination.

**Status:** signed HTTP routing is covered by offline tests. A real Dialpad account, API entitlement, licensed test number and carrier call are still required to qualify the end-to-end integration. This is not a marketplace-approved app or a live-audio/SIP adapter. Completed-call importing is a separate integration.

## Prerequisites

- Node.js 22 or newer. No package installation is needed.
- A Dialpad company administrator and access to the Call Router API. Confirm plan eligibility with Dialpad before buying a license. Assigning a number may require an Additional Number license.
- A dedicated Dialpad test number, office ID, and an existing human target ID/type (`office`, `department`, `callcenter` or `user`). The human target's rules must not route back into this router.
- A separate PyAI number already assigned to the intended agent. Configure its knowledge, greeting, consent and approved tools in the [PyAI Console](https://console.pyai.com). Set a human handoff destination that cannot loop through this router.
- HTTPS hosting for this small callback server and a unique shared signing secret stored privately in both systems. Keep API keys and signing secrets out of frontend code, URLs and logs.

## Run locally

```sh
cp .env.example .env
# Fill the private settings. Leave PYAI_ROUTING_ENABLED=false initially.
npm test
npm start
```

`GET /healthz` returns health and the routing switch. `POST /dialpad/route` accepts only a signed HS256 JWT, with the documented `date_started`, `call_id` and `internal_number` fields. It accepts compact JWT bodies or a JSON string containing that JWT. It rejects unsigned objects, unconfigured inbound numbers, requests outside a five-minute clock window and unsupported signatures. Synchronize the host clock. Callback retries use the signed call start time for a consistent business-hours decision.

Set `BUSINESS_TIME_ZONE`, `BUSINESS_OPEN`, `BUSINESS_CLOSE` and `BUSINESS_DAYS` for the business. Hours are a same-day interval; overnight schedules and holidays need an explicit extension. `ROUTING_MODE=all_calls` forwards all verified calls when enabled. `PYAI_ROUTING_ENABLED=false` always chooses the human target. No account or caller data is logged.

## Connect an isolated test number

1. Deploy the included Dockerfile to your existing HTTPS host. Supply settings through its secret/environment controls. Expose only this callback service; do not expose your credentials. The callback performs no outbound API calls and should respond well within Dialpad's five-second limit. Monitor HTTP errors and response latency in your host.
2. With an existing approved Dialpad key, `npm run check:account` makes read-only requests to `/company` and `/callrouters`, printing only access status. It never creates a key or router.
3. Set `DIALPAD_OFFICE_ID` and `PUBLIC_ROUTING_URL=https://your-host/dialpad/route`, then run `npm run setup:plan`. It prints a **disabled** router creation plan without the secret. Use the same private `DIALPAD_ROUTER_SECRET` in Dialpad's `secret` field.
4. Create the router disabled through the [Call Router API](https://developers.dialpad.com/docs/call-routing-via-apis). Configure `default_target_id` and `default_target_type` as the same human destination. Assign only the approved dedicated test number. Do not move customer numbers for this pilot.
5. With an explicit test-call budget, enable the router and set the server switch to true. Verify one after-hours AI conversation, human handoff, business-hours human route, and callback-unavailable fallback. Check the real call record and outcome. A successful HTTP callback alone does not establish a working phone call.
6. Roll back by disabling the Dialpad router first; it should use its configured default target. Then set the server switch false. Preserve call records. Remove only temporary access created for the test when the pilot ends.

Dialpad can automatically disable a router after slow responses or repeated errors. An invalid signature gets a non-200 response so Dialpad can use its own default routing; the server does not guess a destination for untrusted input. Confirm this fallback on the real account before widening traffic. The return-source check is only an additional guard: forwarding can preserve caller ID, so distinct destinations and non-looping human rules are mandatory.

Dialpad continues to bill its service and forwarding legs; PyAI bills its agent/telephony usage. Check [PyAI pricing](https://pyai.com/pricing) and your Dialpad contract before activating traffic.

Official references: [Call routing](https://developers.dialpad.com/docs/call-routing-via-apis), [API key administration](https://developers.dialpad.com/docs/api-key-generation).
