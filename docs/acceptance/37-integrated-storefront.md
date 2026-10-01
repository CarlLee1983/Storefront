# Integrated storefront acceptance (#37 / #29 / #1)

## Automated evidence

`bun run e2e` runs the production Web build against real local Workers, isolated D1/R2, and the simulated payment gateway. CI runs this same command and uploads the Playwright HTML report, failure traces and screenshots. No production test-login route is introduced.

`e2e/tests/main-flow.spec.ts` preserves existing failure/retry/idempotency assertions and proves one connected purchase:

- Create an unlisted product, add inventory, reject listing without an image
- Browser resize/upload, failed request retry, lost response after commit replay without duplicate images, multiple-image selection/upload and persisted images
- Publish; home cover loads as WebP with responsive variants and immutable cache headers
- Enter detail from the home card using Tab/Enter; switch the three-image gallery with keyboard arrows/Home/End; Tab to Add, Enter, toast and count update without focus loss
- Cart displays the same cover; fill checkout; pending-payment order
- Real signed gateway webhook returns HTTP 200, payment return reconciliation displays paid
- Admin ships; customer populated order list and detail show shipped, tracking number and the same cover
- Axe runs on populated home, detail, cart, checkout, order list and order detail; also About, FAQ, Returns and a real HTTP 404. Mobile screenshots accompany each stage; order detail also checks 320/768/1280 px

Other suites cover responsive shells, admin image order/delete constraints, reduced motion, failed localStorage writes, quantity/removal, order states and placeholders, native gallery swipe, sold-out and unlisted/not-found detail. RPC and unit coverage enforce the domain rules; the coverage CI job retains its 80% thresholds.

## Manual mobile Lighthouse (not CI)

An automated axe pass or a screenshot is **not** a Lighthouse score. This acceptance remains pending until actual reports are recorded on [issue #37](https://github.com/CarlLee1983/Storefront/issues/37). Do not infer performance from an empty preview catalog or substitute static/mocked HTML for the Worker routes.

Prerequisites: a supported local workerd environment, Bun, installed Google Chrome, repository dependencies. Use a separate checkout at the exact candidate commit. No production secrets are needed. This uses only isolated local data and the existing harness's local-only Access verification configuration (ADR 0002).

1. `bun install --frozen-lockfile`
2. Terminal A: `cd e2e && bun harness/serve.ts`. Wait for `http://localhost:8790`. This rebuilds `.wrangler/e2e` state on every start. Ports 8790/8791 and inspector ports 9330/9331 must be free.
3. Terminal B: `cd e2e && bun harness/manual-lighthouse.ts`. It opens installed Chrome, creates one stocked product through the admin UI, uploads three PNGs through the real browser resizing pipeline, publishes it, and adds it to the customer's cart. The customer browser has no admin headers. It prints the exact home/detail/cart URLs and Chrome version. Keep Terminal A running.
4. In the open customer Chrome window, open DevTools → Lighthouse. Use Navigation, Mobile, Performance and Accessibility with default simulated throttling. Turn **Clear storage off** so the real populated localStorage cart survives navigation. Keep the same context for all three pages. Do not enable desktop mode or replace application requests with mocks.
5. Measure the printed home, product detail, and populated cart URLs separately. Save each HTML and JSON report. Record the actual Lighthouse and Chrome versions, UTC timestamp, exact commit, URL, environment, storage setting, product/image count and both scores. Check that the report final URL is the intended page and its screenshot has the product/cart content.
6. Both Performance and Accessibility must be ≥90 on each route. If not, inspect the report, fix the underlying problem, rerun all affected checks and publish the new reports. Do not select a passing run while omitting a known failure; document reruns and causes.
7. Comment on #37 with measured values and report links/files. CI must separately pass on the same code. Close Chrome and stop Terminal A to clean up local processes. No Lighthouse score gate or Lighthouse job belongs in CI.

Suggested issue report fields:

| Commit / UTC time / environment | Chrome / Lighthouse | Route and populated state | Performance | Accessibility | HTML / JSON |
| --- | --- | --- | --- | --- | --- |
| actual values only | actual versions | home | pending | pending | pending |
| same candidate | actual versions | detail (three images) | pending | pending | pending |
| same candidate | actual versions | cart (one item + cover) | pending | pending | pending |

Local synthetic fixtures exercise actual production-built routes and delivery through local R2, but do not measure deployed network latency. Label them as local production-build results. Any later deployed measurement should be reported separately.

## Parent acceptance audit boundaries

#29: child implementation and green CI are evidence for functional behavior, but do not waive the explicit manual Lighthouse criterion. Production deployment is not part of #37. Existing preview/production products without images become unlisted through migration; restoring real products requires an authorized administrator to upload their actual images.

#1: integrated E2E retains webhook signature delivery, return reconciliation, stock checkout and shipping. Domain suites separately cover concurrency, idempotency, late payment reclaim/refund, cancellation, expiry and privacy. Closing child issues alone is not integrated verification.

One legacy wording difference remains: story 49 asks for a callback delayed by N seconds. The existing implementation (owner-merged PR #19, closed #7, documented in README) deliberately records a deferred event for explicit delivery/replay from the gateway console; it has no N-second timer. ADR 0001 requires late-callback testability but does not explicitly waive the timer wording. Treat owner acceptance of the merged implementation as an inference, not proof that literal N-second delay was tested or implemented; preserve the current deterministic design unless the owner requests a change.
