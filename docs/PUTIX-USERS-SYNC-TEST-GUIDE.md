# PUTIX Users Sync — PowerShell Test Guide (Internal)

Tests for the **users sync** feature only:
- `GET /api/integrations/v1/users`
- `GET /api/integrations/v1/users/:id`
- write-back `assigned_to` on `PATCH /tickets/:id`

> Internal — contains the real API key. Do **not** share with PUTIX (give them `PUTIX-USERS-SYNC-v1.md`).

---

## 1. Setup

```powershell
$base    = "http://localhost:3001/api/integrations/v1"
$apiKey  = "0VFn22-nHvDiErofJEsPfDa8lCfrEWaw38EgIwacbc8JbEQ4LEqxrLDGfoh710uJ"
$headers = @{ "X-API-Key" = $apiKey }
```

---

## 2. List users (full catalog)

```powershell
Invoke-RestMethod -Uri "$base/users?is_active=true&limit=50" -Headers $headers | ConvertTo-Json -Depth 6
```

Expected: `users[]` with `id`, `email`, `full_name`, `role`, `is_active`, `updated_at`.

### Filter by role

```powershell
Invoke-RestMethod -Uri "$base/users?role=seller&is_active=true" -Headers $headers | ConvertTo-Json -Depth 6
Invoke-RestMethod -Uri "$base/users?role=seller,dispatcher&is_active=true" -Headers $headers | ConvertTo-Json -Depth 6
```

### Delta polling

```powershell
$since = (Get-Date).AddDays(-7).ToUniversalTime().ToString("o")
Invoke-RestMethod -Uri "$base/users?is_active=true&updated_since=$since" -Headers $headers | ConvertTo-Json -Depth 6
```

### Include inactive

```powershell
Invoke-RestMethod -Uri "$base/users?is_active=all&limit=100" -Headers $headers | ConvertTo-Json -Depth 6
```

---

## 3. Get one user

```powershell
$list   = Invoke-RestMethod -Uri "$base/users?is_active=true&limit=1" -Headers $headers
$userId = $list.users[0].id
Invoke-RestMethod -Uri "$base/users/$userId" -Headers $headers | ConvertTo-Json -Depth 6
```

### Unknown user → 404

```powershell
try { Invoke-RestMethod -Uri "$base/users/00000000-0000-0000-0000-000000000000" -Headers $headers }
catch { $_.ErrorDetails.Message }
```

---

## 4. Assign user to a ticket (take)

```powershell
$tickets  = Invoke-RestMethod -Uri "$base/tickets?status=pending,pending_review,in_progress,ready&limit=1" -Headers $headers
$ticketId = $tickets.tickets[0].id
$users    = Invoke-RestMethod -Uri "$base/users?role=seller&is_active=true&limit=1" -Headers $headers
$userId   = $users.users[0].id
"ticket=$ticketId  assign=$userId ($($users.users[0].full_name))"

$body = @{
  ticket = @{
    assigned_to = $userId
    status      = "in_progress"
  }
} | ConvertTo-Json -Depth 10

Invoke-RestMethod -Method Patch -Uri "$base/tickets/$ticketId" -Headers $headers -ContentType "application/json" -Body $body | ConvertTo-Json -Depth 8
```

Expected: `updated.ticket_fields` includes `assigned_to`; response `ticket.ticket.assigned_to` / `assigned_to_user` matches.

### Verify

```powershell
$detail = Invoke-RestMethod -Uri "$base/tickets/$ticketId" -Headers $headers
$detail.ticket.assigned_to
$detail.ticket.assigned_to_user
$detail.ticket.assigned_at
```

### Unassign

```powershell
$body = @{ ticket = @{ assigned_to = $null } } | ConvertTo-Json -Depth 10
# PowerShell ConvertTo-Json may omit null — prefer explicit JSON:
$body = '{"ticket":{"assigned_to":null}}'
Invoke-RestMethod -Method Patch -Uri "$base/tickets/$ticketId" -Headers $headers -ContentType "application/json" -Body $body | ConvertTo-Json -Depth 6
```

---

## 5. Guard tests

### Invalid UUID → 400

```powershell
$body = '{"ticket":{"assigned_to":"not-a-uuid"}}'
try { Invoke-RestMethod -Method Patch -Uri "$base/tickets/$ticketId" -Headers $headers -ContentType "application/json" -Body $body }
catch { $_.ErrorDetails.Message }
```

### Unknown user → 400

```powershell
$body = '{"ticket":{"assigned_to":"00000000-0000-0000-0000-000000000000"}}'
try { Invoke-RestMethod -Method Patch -Uri "$base/tickets/$ticketId" -Headers $headers -ContentType "application/json" -Body $body }
catch { $_.ErrorDetails.Message }
```

### No API key → 401

```powershell
try { Invoke-RestMethod -Uri "$base/users" }
catch { $_.ErrorDetails.Message }
```

---

## Checklist

- [ ] List active users
- [ ] Filter by role
- [ ] `updated_since` delta
- [ ] GET by id
- [ ] Unknown user → 404
- [ ] PATCH assign `assigned_to` + `status`
- [ ] `assigned_to_user` populated on GET
- [ ] Unassign with `null`
- [ ] Invalid / unknown assignee → 400
- [ ] Missing key → 401
