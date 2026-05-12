# VaultCore POS Instruction Manual

Last updated: May 8, 2026

This manual is written for daily store use. It explains what each screen is for, the safest workflow to follow, and what the POS does automatically with inventory, customer records, store credit, loyalty, bundles, layaways, trade-ins, reports, and closeout.

## Table Of Contents

1. Daily Quick Guide
2. Core Rules Staff Should Know
3. Dashboard
4. POS Register
5. Customers
6. Inventory
7. Add Item
8. Bundles
9. Wishlist
10. Loyalty And Store Credit
11. Layaways
12. Preorders
13. Repairs
14. Trade-In Workbench
15. Open Work
16. Reports
17. Closeout
18. Accounting
19. Community Events
20. Live Events
21. Categories
22. Users And Permissions
23. Settings
24. Channel Sync
25. VaultCore Brain
26. Troubleshooting
27. Current Limits To Remember

## 1. Daily Quick Guide

### Opening The Day

1. Sign in.
2. Open the Dashboard.
3. Check Today's Snapshot, Recent Activity, Hot Sheet, and Open Work.
4. If you track drawer cash, open Closeout and enter Opening Cash for the business date.
5. Check Inventory alerts for low stock, old inventory, missing categories, and bundle availability.

### Ringing A Normal Sale

1. Open POS.
2. Scan the barcode, type the SKU, or search by title.
3. Add the item to the cart.
4. Select or enter the customer if needed.
5. Apply discounts only when approved.
6. Enter payment.
7. Press Complete Sale.
8. Print receipt if needed.

### Using Store Credit

1. Select an existing customer in POS.
2. Add items to the cart.
3. Enter the store credit amount.
4. Press Store Credit as the tender.
5. Finish any remaining balance with another tender.
6. Complete the sale.

Store credit cannot be used without a selected customer.

### Creating A Layaway

1. Open POS.
2. Build the cart exactly like a sale.
3. Select or enter the customer.
4. Press Create Layaway.
5. Enter the deposit amount.
6. Enter a due date if needed.

Layaway reserves inventory immediately.

### Checking Customer Wishlist Matches

1. Open Inventory.
2. Look for the star badge next to item titles.
3. Click the star to see matching customers.
4. Open the customer profile if you need their wishlist history or contact details.

### Closing The Day

1. Open Closeout.
2. Select the business date.
3. Refresh totals.
4. Count cash.
5. Enter Opening Cash, Paid In, Paid Out, and Counted Cash.
6. Review Expected Cash and Variance.
7. Save Draft if still checking.
8. Close Day when final.

## 2. Core Rules Staff Should Know

### Inventory Rules

- Completed POS sales reduce inventory.
- Voids and refunds restore inventory for the affected items.
- Write Off removes inventory for non-sale reasons such as damage, shrink, or store use.
- Deleted inventory is removed from normal inventory views.
- Add Item can group matching accessories under one SKU when category, platform, title, and New/Used match.

### Bundle Rules

- Bundles are managed from Inventory.
- A bundle creates its own sellable POS item.
- A bundle is available only when all component items are in stock.
- If a component sells individually, the bundle becomes unavailable.
- If a bundle sells, the POS removes the component items from inventory.
- If a bundle is voided or refunded, the component items are restored.
- If a bundle is put on layaway, the component items are reserved.
- If that layaway is cancelled, the component items are restored.
- Bundles cannot contain other bundles.
- Bundles should be sold or reserved one at a time.

### Layaway Rules

- Layaway creation happens from POS.
- Layaway reserves items immediately.
- Layaway cancellation restores reserved items.
- Layaway completion marks the layaway complete.
- Layaway payments are managed from Open Work.

### Wishlist Rules

- Wishlist requests belong to the customer profile.
- Inventory shows a star when an item matches one or more active customer wishlist requests.
- Matching uses the requested title, platform, category, condition preference, and max price when entered.
- Fulfilling or cancelling a wishlist request updates the customer record.

### Loyalty Rules

- Loyalty belongs to the customer profile.
- Sales award 1 point per sale dollar.
- Voids and refunds reverse points.
- 100 points redeems to $5 store credit.
- Manual loyalty adjustments should be used only for corrections, promos, or manager-approved situations.

### Store Credit Rules

- Store credit is tied to a customer.
- Store credit can be adjusted from Customers by users with permission.
- Trade-ins paid as store credit add credit to the customer.
- Store credit tender in POS requires the customer to be selected.

### Trade-In Rules

- Trade-in quotes can be saved.
- Accepted trade-ins can post kept items into inventory.
- Store credit payout updates the customer credit balance when a customer is selected.
- Cash payout is tracked on the quote.

## 3. Dashboard

Use the Dashboard as the starting point for the store.

Main areas:

- Today's Snapshot: high-level daily activity.
- Inventory Health: signals around stock and inventory condition.
- Dormant Inventory: items that may need markdowns, bundles, or attention.
- Trade-In Flow: pending trade-in activity.
- Recent Activity: newly added items and store actions.
- Hot Sheet: notable inventory signals.
- Store Notes: local notes saved on this register only.

Main buttons:

- Add Item
- Inventory
- Trade-In
- Open Work
- Categories
- POS
- Closeout
- Live Events
- Community Events
- Customers
- Users & Permissions
- Reports
- Accounting
- Settings
- Channel Sync
- VaultCore Brain

## 4. POS Register

The POS screen is for checkout, returns, recent sale lookup, store credit tender, layaway creation, and receipt printing.

### Main Register Areas

- Active Cart: current sale lines.
- Totals: subtotal, discount, tax, and total due.
- Tender: cash, card, store credit, exact, and round up.
- Scan / Search: barcode, SKU, or title search.
- Customer: selected customer, walk-in customer, tax status.
- Held Sales: hold and recall unfinished carts.
- Recent Sales: lookup previous sales, voids, and refunds.

### Add Items To Cart

1. Scan a barcode or type a SKU/title in Scan / Search.
2. Press Add or select the matching result.
3. Confirm the cart line quantity and price.

If an item has no quantity available, POS blocks adding it to the cart.

### Select A Customer

1. Search by name, phone, or email.
2. Pick the customer from results.
3. Confirm the selected customer appears.

Use Walk-in if no customer record is needed.

Use a selected customer when:

- Using store credit
- Tracking loyalty
- Creating a layaway
- Applying customer tax-exempt status
- Connecting the sale to customer history

### Discounts

Discount options include preset percent discounts, preset dollar discounts, custom dollar discount, and custom percent discount.

Manager approval may be required depending on Settings.

### Tax Exempt

Tax exemption can come from a customer profile or the Tax Exempt button. Use it only when the customer or transaction qualifies.

### Payment

Available tender buttons:

- Cash
- Card
- Store Credit
- Exact
- Round Up

The POS tracks Paid, Change, and Balance. A sale cannot be completed if payment is short.

### Complete Sale

1. Confirm cart lines.
2. Confirm customer.
3. Confirm discounts and tax.
4. Enter tender.
5. Press Complete Sale.

After completion:

- Inventory is reduced.
- Loyalty points are awarded when a customer is attached.
- Store credit is deducted if used.
- Bundle components are reduced if a bundle was sold.
- Receipt can be printed.

### Hold And Recall

Use Hold when a customer pauses checkout.

Use Recall to bring the held cart back.

Held sales are not final sales and do not reduce inventory until completed.

### Create Layaway From POS

1. Build the cart.
2. Select or enter the customer.
3. Press Create Layaway.
4. Enter deposit.
5. Enter due date if needed.

The cart items are reserved immediately. This includes bundle components when the layaway contains a bundle.

### Recent Sales, Voids, And Refunds

Use Recent Sales to find completed sales.

Voids:

- Cancel the sale.
- Restore inventory.
- Reverse loyalty points.
- Restore bundle components when applicable.

Refunds:

- Refund selected quantities.
- Restore those quantities to inventory.
- Reverse loyalty points for the refunded amount.
- Restore bundle components when applicable.

## 5. Customers

The Customers screen is the home for customer identity, tax status, loyalty, store credit, wishlist, notes, and customer-specific open work.

### Directory

Use the left side to:

- Search customers by name, phone, email, or EIN.
- Filter by regular/business.
- Filter by tax status.
- Filter active/inactive customers.
- Export customer CSV.
- Find duplicate customers.
- Merge duplicate customers.

### Customer Profile

Use the right side to manage:

- Identity
- Phones
- Emails
- EIN for business customers
- Tax-exempt status and expiration
- Tags
- Flag reason
- Address
- Store credit
- Loyalty
- Wishlist
- Layaways
- Preorders
- Repairs
- Activity timeline
- Sales history
- Notes

### Tax Exempt Customers

For tax-exempt customers:

1. Select the customer.
2. Check Tax Exempt.
3. Add an expiration date if needed.
4. Save.

When selected in POS, the customer tax status helps the register apply the right tax behavior.

### Store Credit Adjustments

Use Apply Adjustment to add or remove store credit.

Examples:

- Trade-in correction
- Manager-approved customer credit
- Customer service credit
- Balance correction

Use a negative amount to reduce credit.

### Customer Notes

Use notes for preferences, repair history, special handling, or customer service context.

## 6. Inventory

Inventory is the main stock management screen.

Use it to:

- Search inventory.
- Filter by category, platform, condition, and stock level.
- See total units, value, cost basis, and profit.
- See inventory age and margin snapshots.
- Mark reorder flags.
- Reprint labels.
- Adjust prices.
- Write off inventory.
- Delete inventory.
- Import/export CSV.
- Print inventory lists.
- Manage bundles.
- See wishlist match stars.

### Inventory Table

Main columns include:

- SKU
- Art/platform icon
- Title
- Platform
- Category
- Condition
- Cost
- Price
- Quantity
- Reorder
- Age
- Created
- Barcode
- Actions

### Wishlist Stars

A star badge beside a title means the item matches an active customer wishlist.

Click the star to see:

- Customer name
- Contact info
- Wanted item
- Max price
- Notes

### Write Off

Use Write Off when stock leaves inventory outside a normal sale.

Examples:

- Damaged item
- Missing item
- Store use
- Shrink

Write Off changes inventory and records the reason.

### Reprint Labels

Use Reprint on a row or select multiple rows and use the bulk Reprint button.

Choose the label size before printing bulk labels.

### Import And Export

Use Import CSV for inventory imports.

Use Export CSV for inventory exports.

Use Wix Export (In Stock) when preparing channel inventory exports.

### Inventory Alerts

Inventory alerts highlight:

- Low stock
- High value singles
- Old expensive items
- Missing categories
- Bundle availability

## 7. Add Item

Use Add Item for normal inventory intake.

Main fields:

- Title
- Platform
- Manufacturer barcode
- Category
- Condition
- Source
- Quantity
- Cost
- Price
- Barcode size
- Label printing

### AI Suggested Retail

The AI pricing area can help estimate retail price.

Use it to:

- Choose condition.
- Choose category.
- Choose completeness.
- Exclude lots when checking comps.
- Apply low, median, or high suggested pricing to the item price.

Treat AI pricing as guidance. Staff should still verify rare, damaged, incomplete, or unusually clean items manually.

### Grouping And Barcode

Use Refresh Grouping & Barcode before saving when needed.

Accessories with matching category, platform, title, and New/Used may group under one SKU. When grouped, quantity increases and average cost is recalculated.

## 8. Bundles

Bundles are managed from Inventory.

### Create A Bundle

1. Open Inventory.
2. Press Bundles.
3. Enter bundle title.
4. Enter SKU or leave blank for an automatic bundle SKU.
5. Enter bundle price.
6. Add component items and quantities.
7. Press Create Bundle.

After creation:

- A sellable bundle item appears for POS.
- Bundle availability follows component inventory.
- The bundle appears in Inventory and POS only when components are available.

### Bundle Availability

A bundle is available only when all required components are in stock.

Example:

- Bundle needs 1 PS2 console and 1 PS2 controller.
- If the controller sells individually, the bundle becomes unavailable.
- If another controller is added to inventory, the bundle can become available again.

### Bundle Sale

When a bundle sells:

- The bundle is marked sold/unavailable.
- The component items are removed from inventory.
- The bundle POS item quantity becomes 0.

### Bundle Layaway

When a bundle is placed on layaway:

- Component items are reserved.
- The bundle becomes unavailable to other shoppers.
- Cancelling the layaway restores the component items.
- Completing the layaway marks the bundle sold.

## 9. Wishlist

Wishlist belongs to Customers, with global matches visible in Inventory and Open Work.

### Add A Wishlist Request

1. Open Customers.
2. Select the customer.
3. Go to Wishlist.
4. Enter wanted item.
5. Add platform, max price, and notes if needed.
6. Press Add Wishlist Item.

### Fulfill Or Cancel

Use Fulfill when the customer buys or no longer needs the request because it was satisfied.

Use Cancel when the customer no longer wants it.

### Find Matches

Matches appear in:

- Inventory as a star badge on matching items.
- Customer profile under Wishlist.
- Open Work under Wishlist Matches.

## 10. Loyalty And Store Credit

Loyalty and store credit live on the customer profile.

### Loyalty

Rule:

- 1 point per sale dollar.
- 100 points redeems to $5 store credit.

Use Adjust Points for:

- Promotions
- Corrections
- Manager-approved exceptions

### Store Credit

Store credit can come from:

- Trade-ins
- Loyalty redemption
- Manual adjustment
- Customer service correction

Store credit can be spent in POS only when the customer is selected.

## 11. Layaways

Layaway creation happens in POS. Layaway management happens in Open Work and on the customer profile.

### Create Layaway

1. Build the cart in POS.
2. Select or enter customer.
3. Press Create Layaway.
4. Enter deposit.
5. Enter due date if needed.

### Take A Layaway Payment

1. Open Open Work.
2. Find the layaway.
3. Press Payment.
4. Enter amount.

### Complete Layaway

1. Open Open Work.
2. Find the layaway.
3. Confirm balance and customer.
4. Press Complete.

### Cancel Layaway

1. Open Open Work.
2. Find the layaway.
3. Press Cancel.
4. Confirm cancellation.

Cancellation restores reserved inventory.

## 12. Preorders

Preorders are tracked from Open Work and shown on customer profiles.

Use preorders for items not yet in stock or not yet released.

Main fields:

- Customer
- Title
- Platform
- Deposit
- Release date

Statuses:

- Open
- Notified
- Fulfilled
- Cancelled

## 13. Repairs

Repairs are tracked from Open Work and shown on customer profiles.

Main fields:

- Customer
- Device
- Issue
- Estimate
- Due date

Statuses:

- Intake
- Diagnosing
- Approved
- Waiting parts
- Ready
- Picked up
- Cancelled

Use Ready when the customer should be contacted for pickup.

Use Picked Up when the item has been returned to the customer.

## 14. Trade-In Workbench

Use Trade-In for quoting and accepting customer trade-ins.

### Trade-In Flow

1. Open Trade-In.
2. Search/select customer or use walk-in details.
3. Add each trade item.
4. Enter title, platform, condition, quantity, and target retail.
5. Use AI and comps if helpful.
6. Review cash and credit offers.
7. Save the quote.
8. Accept the quote when the customer agrees.

### Keep Checkbox

Items marked Keep are posted to inventory when the trade is accepted.

Items not marked Keep are not posted as sellable inventory.

### Payout

Trade payout can be cash or store credit.

If store credit is selected and a customer is attached, the customer's store credit balance is increased.

### Quote Settings

Trade-In Settings control:

- Quote expiry days
- Credit percent of retail
- Cash percent of credit
- Cash approval limit
- Credit approval limit
- Comp lookup behavior

## 15. Open Work

Open Work is the staff follow-up queue. It is not the home for every feature.

Use Open Work to see:

- Wishlist matches
- Active layaways
- Bundle availability issues
- Preorders
- Repairs

Where work lives:

- Wishlist creation lives in Customers.
- Loyalty lives in Customers.
- Bundle setup lives in Inventory.
- Layaway creation lives in POS.
- Layaway follow-up lives in Open Work.
- Preorders and repairs currently live in Open Work and customer profiles.

## 16. Reports

Reports are for reviewing sales, inventory, people, events, and operations.

### Running Reports

1. Pick Start and End dates.
2. Press Run Reports.
3. Switch between report tabs.
4. Print or export the active view if needed.

Report tabs:

- Sales
- Inventory
- People
- Events
- Operations

Reports may require Reports permission.

## 17. Closeout

Closeout is for counting the drawer and finalizing the business day.

### Closeout Fields

- Business Date
- Opening Cash
- Paid In
- Paid Out
- Counted Cash
- Notes

### Closeout Totals

The screen shows:

- Register totals
- Payment mix
- Expected cash
- Counted cash
- Variance
- Closeout history

### Draft Vs Closed

Save Draft when still reviewing.

Close Day when the drawer count is final.

## 18. Accounting

Accounting is for expenses, tax summaries, tax filings, and closeout review.

Tabs:

- Summary
- Expenses
- Tax
- Closeouts

### Expenses

Use Add Expense for operating or inventory expenses.

Inventory adds from Add Item are logged automatically.

### Sales Tax

Use Tax to review:

- Taxable sales
- Exempt sales
- Tax collected
- Filing periods
- Filing status
- Amount due and paid

This screen helps organize filing records, but it does not replace professional tax review.

## 19. Community Events

Community Events is for tournaments, prereleases, leagues, trade nights, and signups.

Use it to:

- Create events.
- Set event status.
- Manage event details.
- Add signups.
- Check players in.
- Track paid/unpaid attendees.
- Create and print tickets.
- Export attendees.

Event statuses:

- Scheduled
- Check-In
- Live
- Completed
- Cancelled

## 20. Live Events

Live Events is for channel-style or pop-up selling, such as Whatnot, eBay, expo, pop-up, in-store, or other event sales.

Use it to:

- Create a live event.
- Add inventory lines by scan, SKU, or title.
- Save a draft.
- Override total sold amount.
- Finalize and update inventory.
- Void and restore inventory.
- Export event data.

Important:

- Draft events do not finalize inventory.
- Finalize + Update Inventory reduces inventory.
- Void Sale + Restore Inventory restores inventory.

## 21. Categories

Categories is for managing inventory categories.

Use it to:

- Add categories.
- Maintain consistent category names.
- Keep inventory filtering and reporting cleaner.

Good categories help reporting, pricing, and exports.

## 22. Users And Permissions

Users & Permissions controls staff accounts, roles, passwords, PINs, and access.

Roles include:

- Owner
- Manager
- Clerk
- Viewer

Permissions include:

- Add Inventory
- Edit Inventory
- Delete Inventory
- Price / Cost Changes
- Category Admin
- User Admin
- Checkout
- Reports
- Discounts
- Void / Refund
- Settings
- Closeout
- Tax Settings
- Sync Access
- Store Credit

Use the least permission needed for each staff member.

## 23. Settings

Settings controls store defaults, register behavior, trade-in policy, AI behavior, local register preferences, export columns, and system status.

Tabs:

- Store
- Register
- Trade-In
- AI
- Local
- System

### Store

Controls:

- Store name
- Phone
- Email
- Website
- Address
- Low stock threshold
- Default inventory category
- Default markup
- Receipt footer
- Owner lock for store profile/defaults

### Register

Controls:

- Default sales tax
- Owner lock
- Manager PIN requirement for price overrides
- Manager PIN requirement for discounts

Inventory removal on sale and restock on return are enabled as core POS behavior.

### Trade-In

Controls:

- Quote expiry days
- Cash approval limit
- Credit approval limit
- Comp country
- Sold eBay comps
- Active eBay listings

### AI

Controls:

- AI mode
- Chattiness
- AI status

### Local

Controls:

- Loading screen on this register
- Customer CSV export columns

Local settings apply only to that register.

### System

Use System Status to check API, integrations, and background run status.

## 24. Channel Sync

Channel Sync Monitor is for external channel inventory monitoring.

Use it to:

- View latest sync status per SKU.
- View recent sync log.
- Link Wix products by SKU.
- Look up SKU in a channel.

Only staff with sync access should manage channel sync.

## 25. VaultCore Brain

VaultCore Brain is the AI insight screen.

Use it to:

- Review AI feed/insights.
- Refresh AI analysis.
- Ask questions in Talk to the Brain.
- Control AI mode and chattiness from Settings.

AI should be treated as decision support. Staff should verify prices, policies, and unusual transactions.

## 26. Troubleshooting

### Item Will Not Add To POS

Check:

- Is quantity greater than 0?
- Is the item deleted?
- Is the SKU correct?
- Is the bundle unavailable because components are missing?

### Store Credit Will Not Work

Check:

- Is a customer selected?
- Does the customer have enough store credit?
- Is the tender amount correct?

### Bundle Is Unavailable

Check:

- Are all component items in stock?
- Did one component sell individually?
- Is one component reserved on layaway?
- Is the bundle archived, inactive, sold, or missing components?

### Layaway Quantity Looks Wrong

Remember:

- Creating a layaway reserves stock.
- Cancelling a layaway restores stock.
- Bundle layaways reserve component items.

### Wishlist Star Appears On Inventory

This means at least one active customer wishlist matches that item. Click the star to see the matching customers.

### Tax Looks Wrong

Check:

- Customer tax-exempt status.
- Tax Exempt button in POS.
- Register tax rate in Settings.
- Whether a customer exemption has expired.

### Receipt Or Label Does Not Print

Check:

- Printer is connected.
- Browser/app popups are not blocked for print windows.
- Correct label size is selected.
- Barcode preview appears before printing.

### Reports Or Accounting Will Not Load

Check:

- User has Reports permission.
- Correct date range is selected.
- Refresh the page.
- Confirm the local server is running.

### Sync Is Not Updating

Check:

- User has Sync Access.
- SKU exists in both VaultCore and the channel.
- Use Link Wix Products by SKU.
- Review Recent Sync Log.

## 27. Current Limits To Remember

These workflows exist, but some handoffs are still manual:

- Layaway completion marks the layaway complete, but it does not yet create a full POS sale receipt automatically.
- Preorders track customer promises, deposits, and status, but they do not yet auto-convert incoming stock into notifications or sales.
- Repairs track ticket status, estimates, and pickup flow, but they do not yet convert parts/labor into a POS invoice automatically.
- VaultCore Brain and AI pricing are guidance tools, not automatic pricing authority.
- Store Notes on the Dashboard are saved locally on that register only.

## Recommended Staff Routine

### Every Morning

1. Check Dashboard.
2. Check Open Work.
3. Review Inventory alerts.
4. Confirm printer/scanner.
5. Enter opening cash if using Closeout.

### During The Day

1. Use POS for every normal sale.
2. Select customers whenever loyalty, store credit, tax exemption, layaway, or history matters.
3. Use Customers for wishlist and loyalty.
4. Use Inventory for stock, labels, and bundles.
5. Use Open Work for follow-ups.

### End Of Day

1. Review Recent Sales if needed.
2. Complete refunds/void corrections before closeout.
3. Count drawer.
4. Save or close Closeout.
5. Review Accounting/Reports as needed.
