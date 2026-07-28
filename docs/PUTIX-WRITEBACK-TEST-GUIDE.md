# PUTIX Write-Back — PowerShell Test Guide (Internal)

Focused test guide for **only the new write-back feature**:
`PATCH /api/integrations/v1/tickets/:id` (plus its `PUT` alias) and the new `created_since` filter.

> Internal file — contains the real API key. **Do not share with PUTIX** (give them
> `PUTIX-WRITEBACK-v1.md` instead).

---

## 0. What this feature does

Lets PUTIX update a ticket's **header (cabecera)** and **items (detalle)**. It uses a strict
allow-list: only editable fields are applied; PKs/FKs/identifiers are ignored and reported.
Only tickets in a **syncable** status can be written: `pending`, `pending_review`,
`in_progress`, `ready`.

---

## 1. Setup (run once per PowerShell session)

```powershell
$base    = "http://localhost:3001/api/integrations/v1"
$apiKey  = "0VFn22-nHvDiErofJEsPfDa8lCfrEWaw38EgIwacbc8JbEQ4LEqxrLDGfoh710uJ"
$headers = @{ "X-API-Key" = $apiKey }
```

Get a ticket in a syncable status and one of its item ids:

```powershell
$list     = Invoke-RestMethod -Uri "$base/tickets?status=pending,pending_review,in_progress,ready&limit=1" -Headers $headers
$ticketId = $list.tickets[0].id
$detail   = Invoke-RestMethod -Uri "$base/tickets/$ticketId" -Headers $headers
$itemId   = $detail.items[0].id
"ticketId=$ticketId  itemId=$itemId  status=$($list.tickets[0].status)"
```

---

## 2. Happy-path tests

### 2a. Update header only

```powershell
$body = @{ ticket = @{ seller_notes = "Prueba PUTIX $(Get-Date -Format HH:mm:ss)" } } | ConvertTo-Json -Depth 10
Invoke-RestMethod -Method Patch -Uri "$base/tickets/$ticketId" -Headers $headers -ContentType "application/json" -Body $body | ConvertTo-Json -Depth 8
```

Expected: `updated.ticket_fields` = `["seller_notes"]`, `updated.items_updated` = 0.

### 2b. Update one item only

```powershell
$body = @{ items = @( @{ id = $itemId; selling_price = 25.5; supplier_code = "IMP-001"; status = "positive" } ) } | ConvertTo-Json -Depth 10
Invoke-RestMethod -Method Patch -Uri "$base/tickets/$ticketId" -Headers $headers -ContentType "application/json" -Body $body | ConvertTo-Json -Depth 8
```

Expected: `updated.items_updated` = 1.

### 2c. Header + items together

```powershell
$body = @{
  ticket = @{ priority = "high"; vehicle_info = @{ marca = "CHEVROLET"; modelo = "LUV" } }
  items  = @( @{ id = $itemId; selling_price = 30.0; estimated_delivery = "2 dias" } )
} | ConvertTo-Json -Depth 10
Invoke-RestMethod -Method Patch -Uri "$base/tickets/$ticketId" -Headers $headers -ContentType "application/json" -Body $body | ConvertTo-Json -Depth 8
```

### 2d. PUT alias works the same

```powershell
$body = @{ ticket = @{ notes = "via PUT" } } | ConvertTo-Json -Depth 10
Invoke-RestMethod -Method Put -Uri "$base/tickets/$ticketId" -Headers $headers -ContentType "application/json" -Body $body | ConvertTo-Json -Depth 8
```

### 2e. Verify the change persisted

```powershell
$after = Invoke-RestMethod -Uri "$base/tickets/$ticketId" -Headers $headers
$after.ticket.seller_notes
$after.items | Where-Object { $_.id -eq $itemId } | Select-Object id, selling_price, supplier_code, status
```

---

## 3. Guard / validation tests (should fail with a clear code)

### 3a. Forbidden fields are ignored (not applied) — HTTP 200

```powershell
$body = @{ ticket = @{ k_number = "HACK"; putix_ref = "x"; assigned_to = "00000000-0000-0000-0000-000000000000"; seller_notes = "solo esto aplica" } } | ConvertTo-Json -Depth 10
Invoke-RestMethod -Method Patch -Uri "$base/tickets/$ticketId" -Headers $headers -ContentType "application/json" -Body $body | ConvertTo-Json -Depth 8
```

Expected: only `seller_notes` applied; `ignored_fields.ticket` contains `k_number`, `putix_ref`, `assigned_to`.

### 3b. Invalid enum → 400 VALIDATION_ERROR

```powershell
$body = @{ ticket = @{ status = "banana" } } | ConvertTo-Json -Depth 10
try { Invoke-RestMethod -Method Patch -Uri "$base/tickets/$ticketId" -Headers $headers -ContentType "application/json" -Body $body }
catch { $_.ErrorDetails.Message }
```

### 3c. Item that doesn't belong to the ticket → 400 VALIDATION_ERROR

```powershell
$body = @{ items = @( @{ id = "00000000-0000-0000-0000-000000000000"; selling_price = 10 } ) } | ConvertTo-Json -Depth 10
try { Invoke-RestMethod -Method Patch -Uri "$base/tickets/$ticketId" -Headers $headers -ContentType "application/json" -Body $body }
catch { $_.ErrorDetails.Message }
```

### 3d. Item without id → 400

```powershell
$body = @{ items = @( @{ selling_price = 10 } ) } | ConvertTo-Json -Depth 10
try { Invoke-RestMethod -Method Patch -Uri "$base/tickets/$ticketId" -Headers $headers -ContentType "application/json" -Body $body }
catch { $_.ErrorDetails.Message }
```

### 3e. Empty body → 400 EMPTY_UPDATE

```powershell
$body = @{} | ConvertTo-Json
try { Invoke-RestMethod -Method Patch -Uri "$base/tickets/$ticketId" -Headers $headers -ContentType "application/json" -Body $body }
catch { $_.ErrorDetails.Message }
```

### 3f. Non-syncable ticket (closed/pedido) → 409 TICKET_NOT_SYNCABLE

```powershell
$closed   = Invoke-RestMethod -Uri "$base/tickets?status=closed&limit=1" -Headers $headers
$closedId = $closed.tickets[0].id
$body = @{ ticket = @{ seller_notes = "no aplica" } } | ConvertTo-Json -Depth 10
try { Invoke-RestMethod -Method Patch -Uri "$base/tickets/$closedId" -Headers $headers -ContentType "application/json" -Body $body }
catch { $_.ErrorDetails.Message }
```

### 3g. No API key → 401

```powershell
$body = @{ ticket = @{ seller_notes = "x" } } | ConvertTo-Json
try { Invoke-RestMethod -Method Patch -Uri "$base/tickets/$ticketId" -ContentType "application/json" -Body $body }
catch { $_.ErrorDetails.Message }
```

---

## 4. Polling reflects the write

```powershell
$before = (Get-Date).AddMinutes(-2).ToUniversalTime().ToString("o")
# ...run a PATCH from section 2...
$poll = Invoke-RestMethod -Uri "$base/tickets?updated_since=$before" -Headers $headers
$poll.tickets | Where-Object { $_.id -eq $ticketId } | Select-Object id, k_number, updated_at
```

The patched ticket should appear (its `updated_at` moved forward).

---

## 5. New `created_since` filter (closed-history backfill)

```powershell
$since = "2025-01-01T00:00:00Z"
Invoke-RestMethod -Uri "$base/tickets?status=closed&sort_order=asc&created_since=$since&limit=100" -Headers $headers | ConvertTo-Json -Depth 4
```

---

## 6. (Optional) Attribute writes to a real user

By default writes apply but are **not** attributed (no `updated_by`, no audit row).
To record them, set an existing `users.id` in `.env` and restart the backend:

```
PUTIX_SERVICE_USER_ID=<existing-user-uuid>
```

Then after a PATCH, an `audit_log` row appears with `new_values.source = "putix_writeback"`.

---

## Checklist

- [ ] Header-only PATCH applies
- [ ] Item-only PATCH applies
- [ ] Combined PATCH applies
- [ ] PUT alias works
- [ ] Change persists (verified via GET)
- [ ] Forbidden fields → `ignored_fields` (still 200)
- [ ] Invalid enum → 400
- [ ] Foreign item / missing id → 400
- [ ] Empty body → 400
- [ ] Closed/pedido ticket → 409
- [ ] No key → 401
- [ ] Patched ticket appears in `updated_since` polling
- [ ] `created_since` returns closed history
