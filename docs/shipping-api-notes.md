# Shipping API Notes

Shipping is a planned feature. The current app should keep fulfillment, listing,
inventory, analytics, and map workflows independent of shipping until these API
details are settled.

## Current State

- Etsy shipment creation exists in Rust as a backend capability, but there is no
  completed user-facing shipping workflow.
- USPS and EasyPost clients are present for future tracking/rate work.
- Shipping warnings in `cargo check` are not release blockers for the current
  non-shipping feature set.

## Open Decisions

- Source of truth: decide whether shipments are created through Etsy labels,
  USPS, EasyPost, or a mixed model.
- Scope: decide whether the first version buys labels, records tracking only, or
  only validates addresses/rates.
- Credentials: decide whether carrier credentials are global, per machine, or
  per shop.
- Shop ownership: decide how carrier accounts map to Etsy shops.
- Rate shopping: decide whether rates are shown before purchase and whether
  service/package presets are needed.
- Tracking: decide refresh cadence, cache lifetime, and whether tracking data is
  pulled from USPS, EasyPost, Etsy, or the original label source.
- Failure handling: decide what the operator can retry, edit, void, or manually
  override.

## Candidate First Workflow

1. Select one open physical order.
2. Validate destination address.
3. Choose package preset and service.
4. Purchase or attach label/tracking, depending on chosen provider.
5. Post tracking back to Etsy.
6. Cache the shipment/tracking result for the order row.

## API Questions To Resolve

- Does Etsy label purchase expose enough carrier/rate detail for the desired UX,
  or should EasyPost own label purchase?
- If EasyPost owns labels, should Etsy receive only the final tracking number?
- Should USPS be used directly for tracking only, or replaced by EasyPost
  tracking once EasyPost is connected?
- What package dimensions and weights are canonical for each product family?
- How should international orders be handled?
- What is the rollback path if a label is purchased but Etsy shipment creation
  fails?

## Guardrails

- Keep shipping UI hidden until the provider decision is made.
- Do not make order loading depend on carrier APIs.
- Do not clear or mutate fulfillment/order cache because a shipping API fails.
- Keep API failures visible in the future shipping surface, not as silent logs.
