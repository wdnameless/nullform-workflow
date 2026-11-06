---
description: "On-demand web performance checklist: loading states, image formats, request dedup/debounce, pagination, compression and caching, render scope, parallel independent work, list virtualization, database/query hygiene, telemetry and RUM. Read before optimizing a web UI, HTTP server, API response size, or page load latency."
---

# Web Performance Rules

> On-demand rule. Adopted from YouTube Shorts `XeCssI7RSb0` (2026-11-06).
> Read before performance work on a browser UI, HTTP endpoint, or report page.
> Not every rule applies to every target: this repo's dashboard is local with no
> CDN, database, or third-party services, so those rows are marked n/a below.

## 1. Loading experience

- Show skeletons or placeholders while data is loading; never an empty screen.
- Update the UI optimistically, without waiting for the server round trip.

## 2. Network and payload

- Serve images as WebP or AVIF, not raw PNG/JPEG.
- Enable Brotli or gzip compression for HTML, JSON, and text assets.
- Cache static assets in the browser with explicit cache headers.
- Serve static files from a CDN in production.
- Set timeouts for every external API call.
- Stream responses token by token when the producer supports it.

## 3. Requests and interactions

- Prevent duplicate API requests for the same data.
- Debounce search and autocomplete until the user stops typing.
- Paginate API results; never return an unbounded list.
- Run independent requests in parallel, not sequentially.
- Load third-party scripts after the page has loaded.

## 4. Rendering

- Re-render only what changed; do not rebuild the whole view on every poll.
- Use server-side rendering or static generation where it fits.
- Split JavaScript bundles per page or route.
- Virtualize long lists instead of rendering every row.
- Lazy-load off-screen images only when scrolling.
- Eliminate unnecessary re-renders.
- Host fonts locally and keep the number of styles limited.

## 5. Data layer

- Fix N+1 query problems.
- Add database indexes for frequent queries.
- Select only the necessary columns from the database.
- Use a database connection pool.
- Cache frequently requested data (for example Redis) when a shared store exists.
- Place servers close to the database.
- Offload slow tasks to a background queue.

## 6. Measurement

- Track slow backend requests with OpenTelemetry or an equivalent local trace.
- Monitor real user speed metrics (RUM).
- Test on low-end phones and slow network connections.
- Remove unused dependencies.
- Distribute load across multiple app instances when one is saturated.

## Applicability in this repository

| Rule | Status here |
|---|---|
| Compression, cache headers, ETag, render scope, parallel collectors, debounce, virtualization, skeletons | applicable to the local dashboard |
| CDN, Redis, database indexes, pooling, N+1, queues, SSR/SSG, RUM, multi-instance | not applicable — no CDN, database, or shared cache in this repo |

Never turn these rows into a blocking gate by themselves. A performance rule
becomes a gate only after its measurement is validated against real user or
runtime behavior (see `skill://codebase-design` §5).
