# UI Audit Matrix

Updated: 2026-02-26

## Scope Legend
- `Frozen`: no body/layout changes
- `Header-only`: top section normalization only
- `Header+Body`: broader visual consistency allowed

## Page Classification
- `src/renderer/index.html`: Frozen (dashboard intentionally unique)
- `src/renderer/inventory.html`: Frozen (title/header-only changes allowed)
- `src/renderer/add-item.html`: Header-only
- `src/renderer/pos.html`: Header-only (primary top-stack normalization)
- `src/renderer/live-events.html`: Header-only
- `src/renderer/reports.html`: Header-only
- `src/renderer/trade-in.html`: Header-only
- `src/renderer/ai.html`: Header-only
- `src/renderer/customers.html`: Header+Body
- `src/renderer/settings.html`: Header+Body
- `src/renderer/users.html`: Header+Body
- `src/renderer/sync.html`: Header+Body
- `src/renderer/categories.html`: Header+Body

## Completed Batches
- Batch 1: users/settings/customers/sync header + base visual token alignment
- Batch 2: add-item/ai/categories header harmonization + live-events/pos top polish
- Batch 3: ai/pos/trade-in top-bar parity refinement
- Micro: accessibility + encoding-safe title separators
- Micro: global renderer page title consistency
- Micro: header class naming consistency (`topbar` -> `page-toolbar` where used)

## Remaining Work
- Optional: deeper body rhythm pass for `customers/settings/users/sync/categories` (spacing, section density, table rhythm)
- Optional: targeted text encoding cleanup on legacy mojibake strings in non-frozen pages (safe copy-only pass)
- Optional: final visual QA sweep (desktop + narrow widths)

