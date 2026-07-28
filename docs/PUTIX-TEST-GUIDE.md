# PUTIX Integration — PowerShell Test Guide (Internal)

Quick, copy‑paste PowerShell commands to test the PUTIX integration API v1 (read + write‑back)
against a **local** backend. This file is for the Mini Web / Distrimia team only — it contains a
real API key, so **do not share it with PUTIX**. Give PUTIX `PUTIX-API-v1.md` instead.

---

## 0. Prerequisites

1. Backend running:
   ```powershell
   cd E:\wang\PWA-Ticket\PWA-Ticket-Backend
   npm run dev
   ```
2. `PUTIX_API_KEY` is set in `.env` (already configured).
3. You have at least one ticket in a **syncable** status (`pending`, `pending_review`, `in_progress`, `ready`).

---

## 1. Set up shared variables (run this first)

Paste this once per PowerShell session — every example below reuses `$base` and `$headers`.

```powershell
$base    = "http://localhost:3001/api/integrations/v1"
$apiKey  = "0VFn22-nHvDiErofJEsPfDa8lCfrEWaw38EgIwacbc8JbEQ4LEqxrLDGfoh710uJ"
$headers = @{ "X-API-Key" = $apiKey }
```

> Tip: `Invoke-RestMethod` auto‑parses JSON. Add `| ConvertTo-Json -Depth 10` to pretty‑print the result.

---

## 2. Health check

```powershell
Invoke-RestMethod -Uri "$base/health" -Headers $headers | ConvertTo-Json -Depth 10
```

Expected: `status: "ok"`, `api_key_configured: true`, plus `stats`.

---

## 3. Schema / contract (field catalog + write-back rules)

```powershell
Invoke-RestMethod -Uri "$base/schema" -Headers $headers | ConvertTo-Json -Depth 10
```

Look for the `write_back` section — it lists `editable_ticket_fields`, `editable_item_fields`,
and a body example. This is the source of truth PUTIX codes against.

---

## 4. List tickets (polling + filters)

```powershell
# Basic paginated list
Invoke-RestMethod -Uri "$base/tickets?limit=5" -Headers $headers | ConvertTo-Json -Depth 6

# Only syncable states (what PUTIX polls)
Invoke-RestMethod -Uri "$base/tickets?status=pending,pending_review,in_progress,ready&limit=10" -Headers $headers | ConvertTo-Json -Depth 6

# Delta polling (PUTIX uses lastSyncAt = now - 24h)
$since = (Get-Date).AddHours(-24).ToUniversalTime().ToString("o")
Invoke-RestMethod -Uri "$base/tickets?updated_since=$since" -Headers $headers | ConvertTo-Json -Depth 6
```

---

## 5. Grab one ticket id + a real item id for the write-back tests

```powershell
$list     = Invoke-RestMethod -Uri "$base/tickets?status=pending,pending_review,in_progress,ready&limit=1" -Headers $headers
$ticketId = $list.tickets[0].id
"Ticket id: $ticketId  (k=$($list.tickets[0].k_number), status=$($list.tickets[0].status))"

# Full ticket detail (items live under .items)
$detail = Invoke-RestMethod -Uri "$base/tickets/$ticketId" -Headers $headers
$itemId = $detail.items[0].id
"First item id: $itemId"
```

---

## 6. Ticket blocks (generated text)

```powershell
Invoke-RestMethod -Uri "$base/tickets/$ticketId/blocks" -Headers $headers | ConvertTo-Json -Depth 6
```

---

## 7. WRITE-BACK — the new endpoint

### 7a. Update the header (cabecera)

```powershell
$body = @{ ticket = @{ seller_notes = "Prueba PUTIX $(Get-Date -Format HH:mm:ss)" } } | ConvertTo-Json -Depth 10
Invoke-RestMethod -Method Patch -Uri "$base/tickets/$ticketId" -Headers $headers -ContentType "application/json" -Body $body | ConvertTo-Json -Depth 8
```

Expected: `updated.ticket_fields` contains `seller_notes`; the returned `ticket` reflects the change.

### 7b. Update an item (detalle)

```powershell
$body = @{
  items = @(
    @{ id = $itemId; selling_price = 25.5; supplier_code = "IMP-001"; status = "positive" }
  )
} | ConvertTo-Json -Depth 10
Invoke-RestMethod -Method Patch -Uri "$base/tickets/$ticketId" -Headers $headers -ContentType "application/json" -Body $body | ConvertTo-Json -Depth 8
```

Expected: `updated.items_updated = 1`.

### 7c. Header + items together

```powershell
$body = @{
  ticket = @{ status = "ready"; vehicle_info = @{ marca = "CHEVROLET"; modelo = "LUV" } }
  items  = @( @{ id = $itemId; selling_price = 30.0 } )
} | ConvertTo-Json -Depth 10
Invoke-RestMethod -Method Patch -Uri "$base/tickets/$ticketId" -Headers $headers -ContentType "application/json" -Body $body | ConvertTo-Json -Depth 8
```

---

## 8. Negative / guard tests (these SHOULD fail with a clear code)

### 8a. Forbidden fields are ignored (not applied)

```powershell
$body = @{ ticket = @{ k_number = "HACK"; putix_ref = "x"; seller_notes = "solo esto aplica" } } | ConvertTo-Json -Depth 10
Invoke-RestMethod -Method Patch -Uri "$base/tickets/$ticketId" -Headers $headers -ContentType "application/json" -Body $body | ConvertTo-Json -Depth 8
```

Expected: only `seller_notes` applies; `ignored_fields.ticket` = `["k_number","putix_ref"]`.

### 8b. Invalid enum → 400 VALIDATION_ERROR

```powershell
$body = @{ ticket = @{ status = "banana" } } | ConvertTo-Json -Depth 10
try {
  Invoke-RestMethod -Method Patch -Uri "$base/tickets/$ticketId" -Headers $headers -ContentType "application/json" -Body $body
} catch {
  $_.ErrorDetails.Message   # prints the JSON error body
}
```

Expected: `code: "VALIDATION_ERROR"` with `validation_errors`.

### 8c. Non-syncable ticket → 409 TICKET_NOT_SYNCABLE

Find a `closed`/`pedido` ticket and try to patch it:

```powershell
$closed   = Invoke-RestMethod -Uri "$base/tickets?status=closed&limit=1" -Headers $headers
$closedId = $closed.tickets[0].id
$body = @{ ticket = @{ seller_notes = "no debería aplicar" } } | ConvertTo-Json -Depth 10
try {
  Invoke-RestMethod -Method Patch -Uri "$base/tickets/$closedId" -Headers $headers -ContentType "application/json" -Body $body
} catch {
  $_.ErrorDetails.Message
}
```

Expected: `code: "TICKET_NOT_SYNCABLE"` (HTTP 409).

### 8d. Missing API key → 401

```powershell
try {
  Invoke-RestMethod -Uri "$base/health"
} catch {
  $_.ErrorDetails.Message
}
```

Expected: `code: "API_KEY_MISSING"`.

### 8e. Wrong API key → 401

```powershell
try {
  Invoke-RestMethod -Uri "$base/health" -Headers @{ "X-API-Key" = "wrong-key" }
} catch {
  $_.ErrorDetails.Message
}
```

Expected: `code: "API_KEY_INVALID"`.

---

## 9. Closed-tickets history (for PUTIX internal flow)

```powershell
# Oldest -> newest, page through with page/limit
Invoke-RestMethod -Uri "$base/tickets?status=closed&sort_order=asc&limit=100&page=1" -Headers $headers | ConvertTo-Json -Depth 6

# Incremental backfill by creation date
$since = "2025-01-01T00:00:00Z"
Invoke-RestMethod -Uri "$base/tickets?status=closed&sort_order=asc&created_since=$since&limit=100" -Headers $headers | ConvertTo-Json -Depth 6
```

---

## 10. Verify polling reflects a write-back

```powershell
$before = (Get-Date).AddMinutes(-1).ToUniversalTime().ToString("o")
# ...do a PATCH from section 7...
Invoke-RestMethod -Uri "$base/tickets?updated_since=$before" -Headers $headers | ConvertTo-Json -Depth 4
```

The ticket you patched should be in the list (its `updated_at` moved forward).

---

## 11. (Optional) Attribute write-backs to a real user

By default write-backs apply but are **not** attributed (no `updated_by`, no audit row — avoids a
foreign-key error from the synthetic service account).

To attribute them, put an existing `users.id` in `.env` and restart:

```
PUTIX_SERVICE_USER_ID=<an-existing-user-uuid>
```

Then after a PATCH, an `audit_log` row appears with `new_values.source = "putix_writeback"`.

---

## Test checklist

- [ ] `/health` returns ok
- [ ] `/schema` shows the `write_back` section
- [ ] List + `updated_since` delta works
- [ ] `GET /tickets/:id` returns items
- [ ] PATCH header applies
- [ ] PATCH item applies
- [ ] Forbidden fields land in `ignored_fields`
- [ ] Invalid enum → 400
- [ ] Non-syncable ticket → 409
- [ ] Missing/invalid key → 401
- [ ] `status=closed` history + `created_since` paginate
- [ ] Patched ticket shows up in `updated_since` polling
