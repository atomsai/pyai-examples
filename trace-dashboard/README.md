# Build with Trace

A dashboard you can customize and embed, plus server helpers for summaries and
signed completed-call events. Node 22 or later; no dependency installation.

The console has the same widget under **Trace → Build & embed**. Its editor adds
card ordering, labels, layout import/export, browser-local saves, and CSV export.
This starter is a small standalone app for bringing the widget into another product.

## Open the sample

From this directory:

```sh
npm start
```

Open http://127.0.0.1:3024. The default mode uses clearly marked fictional data
and makes no PyAI requests. Change the layout, window, theme, spacing, and brand
color. Download a layout JSON file or copy the generated embed.

The canonical modules live in `console/public/trace-widgets/`; this starter serves
them directly in the monorepo. The public examples mirror bundles the same
modules under `trace-dashboard/trace-widgets/`, so a public clone runs independently.
To use them outside the repository, copy `trace-dashboard.mjs` and `model.mjs` to
your app's public `/trace-widgets/` directory. Put `server-adapter.mjs` and a copy
of `model.mjs` together in your server source directory, preserving the relative
import. `webhook-receiver.mjs` is independent and runs on the server.

## Preview your organization's data

Copy `.env.example` to `.env`. Set `PYAI_API_KEY` to an existing authorized key
with `trace:read`, then run:

```sh
npm run live
```

The starter binds only to loopback, checks the Host and Origin headers, and keeps
the key on the server. Live mode calls `GET /v1/trace/exposure` using the existing
key. It does not enable Trace, create calls, or send events. A sample widget token
for voice conversations cannot authorize Trace reads. Do not expose this local
server through a public tunnel or reuse its local key resolver in production.

## Add an authenticated app route

Use your own session and authorization helpers. The following is a Next.js route
adapter; `requireWorkspace` and `readTraceKey` are application-specific functions
you must implement. The shared helper uses Web Request/Response, so it also works
in other Node frameworks with their normal adapters.

```js
// app/api/trace-dashboard/route.js
import { traceDashboardResponse } from '@/server/trace-widgets/server-adapter.mjs';
import { requireWorkspace, readTraceKey } from '@/server/workspace-auth';

export const runtime = 'nodejs';

export async function GET(request) {
  return traceDashboardResponse(request, {
    resolveApiKey: async request => {
      const workspace = await requireWorkspace(request);
      if (!workspace?.canViewTrace) return null;
      return readTraceKey(workspace.organizationId);
    },
  });
}
```

The resolver authenticates the user, checks their permission, and gets the key
for the authorized workspace. Never select a tenant key using an unverified
`org_id` query parameter or a payload field. The helper denies access without a
resolver, uses a fixed PyAI host, limits request time, rejects redirects, forwards
no caller headers, and returns an allow-list of aggregate fields. Responses are
private and must not enter a shared CDN cache.

The public contract is [OpenAPI](https://api.pyai.com/openapi.json).
The adapter accepts only `window_days=7`, `30`, or `90`. The upstream exposure
API supports a wider range; the builder deliberately offers these three windows.

## Embed and customize

```html
<script type="module" src="/trace-widgets/trace-dashboard.mjs"></script>
<pyai-trace-dashboard src="/api/trace-dashboard"></pyai-trace-dashboard>
```

For custom settings, use the generated embed or load your layout JSON on the page
and assign it to the element's `config` property. The element validates the layout.
Rendering uses text nodes, so labels and rule IDs are not treated as HTML.

| Setting | Options |
|---|---|
| `title` | Up to 80 characters |
| `theme` | `light`, `dark` |
| `accent` | Six-digit hex color, used on borders and charts |
| `density` | `compact`, `comfortable` |
| `window_days` | `7`, `30`, `90` |
| `max_rules` | 1 to 10 |
| `widgets` | Ordered subset of `scanned`, `pass_rate`, `gaps`, `verdicts`, `rules` |
| `labels` | Optional labels keyed by widget ID, up to 60 characters each |

The widget fetches when connected, when its source or date window changes, and
when the viewer clicks Refresh. It does not poll. Its data endpoint must be on
the same origin as the embedding page. It uses that app's session cookie and
rejects redirects. No iframe permissions, third-party scripts, or analytics are
required. Serve the module with a JavaScript MIME type. The Shadow DOM isolates
its styles; allow the component's inline styles in your app's CSP as appropriate.

### React

Register the custom element in a client effect. Put `src` on it after the layout
is configured to avoid an extra initial request:

```jsx
'use client';
import { createElement, useEffect, useRef } from 'react';

export function CallQuality({ config }) {
  const ref = useRef(null);
  useEffect(() => {
    let active = true;
    import('/trace-widgets/trace-dashboard.mjs').then(() => {
      if (!active || !ref.current) return;
      ref.current.config = config;
      ref.current.setAttribute('src', '/api/trace-dashboard');
    });
    return () => { active = false; };
  }, [config]);
  return createElement('pyai-trace-dashboard', { ref });
}
```

In a bundled app, import the module from your local source instead if the bundler
does not support runtime imports from a public path. In TypeScript, copy the
matching `.d.mts` declarations when importing the source modules.

### Bring your own renderer

`projectExposure()` validates and strips unknown response fields. `exposureCsv()`
exports aggregate counts and rules. You can use these functions with your own
chart library, design system, report generator, or BI ingestion process. A layout
JSON contains presentation settings only; it contains no credentials or call data.
Rule IDs and pack IDs can still reveal internal policy names, so authorize the
summary for its intended audience.

## Receive completed-call events

Configure a signed Webhook in **Trace → Delivery**, usually with WARN and FAIL
selected. Install `webhook-receiver.mjs` in your Node server and bind the secret
and queue to that destination using your server's routing configuration:

```js
import { traceWebhookResponse } from './webhook-receiver.mjs';

export async function POST(request) {
  return traceWebhookResponse(request, {
    secret: await secrets.read('trace-workspace-a-signing'),
    enqueueOnce: async event => {
      // This table IS the durable work queue. The primary key deduplicates
      // delivery IDs; a worker consumes committed rows separately.
      await database.query(
        `INSERT INTO trace_delivery_inbox (delivery_id, payload)
         VALUES ($1, $2::jsonb) ON CONFLICT (delivery_id) DO NOTHING`,
        [event.id, JSON.stringify(event)],
      );
    },
  });
}
```

`secrets` and `database` above are your application's existing server services.
Create a queue table in your application database, not the PyAI database:

```sql
CREATE TABLE trace_delivery_inbox (
  delivery_id text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL,
  processed_at timestamptz
);
```

The helper checks the HMAC of `timestamp + "." + rawBody`, enforces a five-minute
timestamp tolerance, bounds the body to 64 KB, and accepts only
`trace.scorecard.completed`. It returns 202 only after the queue callback resolves;
queue errors return 503 so delivery can retry. Do not parse/re-serialize the body
before verification. Do not replace the durable queue with a memory Set.

Webhook events can carry call IDs, agent IDs, and finding titles. Keep them
private and define retention for the inbox table. A worker should record attempts,
retry transient downstream errors, and delete or archive payloads on your retention
schedule. Deduplicate CRM or ticket writes by delivery ID as well, since a worker
can crash after a downstream write but before marking its queue row processed.

## Other useful views

| View | API or workflow | What to build |
|---|---|---|
| CRM call panel | `GET /v1/trace/interactions/{id}` | Private verdict, findings, citations, and review link |
| Agent review queue | `GET /v1/trace/interactions?agent_id=...&verdict=FAIL` | Cursor-paginated scored calls; assignments live in your app |
| Advisory inbox | `GET /v1/trace/findings?action=escalate` | Separate semantic review stream, not a replacement verdict |
| BI report | `GET /v1/trace/exposure?window_days=30` | Scheduled aggregate snapshots with your own collection timestamps |
| Workflow automation | Signed completed-call event | Queue a ticket, send an internal message, or update your CRM |
| Compliance evidence | Summary CSV and audit templates | Document the reporting period, review decisions, and handoff |

The public exposure endpoint is organization-wide. It does not accept `agent_id`,
project, environment, pack, or arbitrary start/end filters. For an agent-specific
view, paginate interactions with the supported `agent_id` filter and label the
population accurately. Never label a single page as a period-wide total.

## Metric boundaries and release status

PASS rate is `PASS / interactions_scanned`; zero scored calls means an unavailable
rate. `with_a_gap` is WARN plus FAIL. Rule counts represent distinct affected calls
per rule; a call can match multiple rules, so these counts must not be summed into
a number of affected calls. Scored calls are not the eligible-call population.
Advisory findings arrive separately and do not imply unresolved assignments.

This starter uses the existing public exposure contract and the same widget as
the console builder. Vanta, Drata, and Secureframe
connectors remain a separate draft requiring real provider-account qualification.
No marketplace listing, auditor acceptance, privacy erasure connector, or insurance
signal ingestion is established by these examples.
