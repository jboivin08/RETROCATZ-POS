# RetroCatz POS Overnight Punch List (2026-02-25)

## Completed
- [x] Aligned POS header/tabs visual language to match Inventory page colors, borders, and pill controls.
- [x] Swapped POS synthetic logo badge for the same RetroCatz logo asset used across the app.
- [x] Flattened high-contrast gradients in POS quick keys and sales table to match inventory row/column treatment.
- [x] Improved session reliability by replacing static auth headers with `getAuthHeaders()` per request.
- [x] Added catalog search indexing cache to reduce repeated string processing on every lookup.
- [x] Improved search relevance ranking (exact SKU/barcode first, then starts-with, then partial matches).
- [x] Reduced results render overhead by batching DOM inserts with `DocumentFragment`.
- [x] Cleaned key UI copy separators for consistency (`|` in operator guidance rows).
- [x] Fixed broken manager/owner sync monitor access (`requireRole("manager","owner")`), restoring `/api/sync/*` route usability.
- [x] Added permission enforcement to inventory mutation endpoints:
  - `POST /api/items` now requires `inv_add`
  - `PUT /api/items/:id` now requires `inv_edit`
  - price/cost changes require `cost_change`
  - `DELETE /api/items/:id` and `POST /api/items/:id/waste` require `inv_delete`
- [x] Added barcode compatibility endpoint (`GET /barcode?text=...`) used by POS receipt flow.
- [x] Implemented backend trade APIs:
  - `POST /api/trade/suggest` for policy + condition-aware offer calculations
  - `POST /api/trade/analyze-image` (OpenAI-enabled vision path + safe fallback when not configured)
- [x] Wired trade-in frontend to live trade APIs (removed hardcoded TODO alerts).
- [x] Added trade-in draft persistence/resume (`localStorage`) for long appraisal sessions.
- [x] Hardened trade-in table rendering with HTML escaping for AI/user-facing text.
- [x] Upgraded `POST /api/ai/chat` from placeholder response to store-aware operational answers (inventory + sales context, optional OpenAI enhancement).
- [x] Brought Trade-In and RetroCatz Brain visual treatment closer to Inventory page styling language.

## Remaining High-Value Items
- [ ] Move `pos.html` inline `<style>` and `<script>` into dedicated `pos.css` and `pos.js` modules for maintainability.
- [ ] Add a smoke-test script for critical POS paths (scan, discount, tender, complete, void/refund).
- [ ] Sanitize remaining `innerHTML` render blocks that interpolate backend data to lower XSS risk.
- [ ] Add API retry/toast handling for transient backend failures instead of only console + alert.
- [ ] Implement remaining report stubs currently returning `501 not_implemented` where UI expects functionality.

## Suggested Test Checklist For 6:00 AM
- [ ] Launch app and open POS; confirm header/nav colors visually match Inventory page.
- [ ] Scan exact SKU and exact barcode; verify fastest exact-match behavior.
- [ ] Search partial title/platform and verify ranked results feel correct.
- [ ] Complete cash and card sales; verify receipts and recent sales panel still update.
- [ ] Run a refund + void flow from Recent Sales and confirm inventory restoration behavior.
- [ ] Switch tabs on smaller window widths and verify layout remains usable.
