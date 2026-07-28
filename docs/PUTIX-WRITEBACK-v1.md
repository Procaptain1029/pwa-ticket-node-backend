# Mini Web ↔ PUTIX — Endpoint de Actualización (Write-Back) v1

Documento para el equipo **PUTIX**. Describe **únicamente la nueva funcionalidad** solicitada en
`flujo.md`: el endpoint que permite a PUTIX **actualizar la cabecera y el detalle** de un ticket.

Para el resto de la API (lectura, listados, polling) ver `PUTIX-API-v1.md`.

---

## 1. Resumen

| | |
|---|---|
| Método | `PATCH` (también se acepta `PUT` como alias) |
| Ruta | `/api/integrations/v1/tickets/:id` |
| Auth | Header `X-API-Key: <SU_API_KEY>` |
| Base URL | `<BACKEND_PUBLIC_URL>/api/integrations/v1` |
| Actualiza | Cabecera (`ticket`) y/o detalle (`items`) |

---

## 2. Reglas de negocio

1. **Solo estados sincronizables.** El ticket debe estar en `pending`, `pending_review`,
   `in_progress` o `ready`. En otro caso → `409 TICKET_NOT_SYNCABLE`.
2. **Lista blanca (allow-list).** Solo se aplican los campos editables (ver §5). Cualquier PK,
   FK o identificador de integridad que envíen se **ignora** (no es error) y se devuelve en
   `ignored_fields`.
3. **Los ítems se identifican por `id`** y deben pertenecer al ticket.
4. Este endpoint **actualiza ítems existentes**; **no** agrega ni elimina ítems.
5. Al aplicar el cambio se refresca `updated_at`, por lo que el ticket volverá a aparecer en el
   siguiente `GET /tickets?updated_since=...`.

---

## 3. Request

```
PATCH /api/integrations/v1/tickets/{id}
X-API-Key: <SU_API_KEY>
Content-Type: application/json
```

```json
{
  "ticket": {
    "status": "ready",
    "seller_notes": "Confirmado por PUTIX",
    "vehicle_info": { "marca": "CHEVROLET", "modelo": "LUV", "anio": "2004" }
  },
  "items": [
    { "id": "3f2b...uuid", "selling_price": 18.5, "supplier_code": "IMP-001", "status": "positive" }
  ]
}
```

- `ticket` y `items` son **opcionales**, pero debe enviarse al menos uno con contenido.
- Cada objeto de `items` **debe** incluir su `id`.

**Parámetro opcional de query:** `?include_blocks=false` para no recalcular los bloques de texto
en la respuesta (más rápido).

---

## 4. Response

### 4.1 Éxito — `200 OK`

```json
{
  "api_version": "v1",
  "updated": {
    "ticket_fields": ["status", "seller_notes", "vehicle_info"],
    "items_updated": 1
  },
  "ignored_fields": {
    "ticket": [],
    "items": {}
  },
  "ticket": { "...": "payload completo actualizado (igual que GET /tickets/:id)" }
}
```

- `updated` indica qué se aplicó realmente.
- `ignored_fields` indica qué campos se descartaron (por no ser editables).

### 4.2 Ejemplo con campos ignorados — `200 OK`

Request:
```json
{ "ticket": { "k_number": "HACK", "putix_ref": "x", "seller_notes": "ok" } }
```
Response:
```json
{
  "updated": { "ticket_fields": ["seller_notes"], "items_updated": 0 },
  "ignored_fields": { "ticket": ["k_number", "putix_ref"], "items": {} },
  "ticket": { "...": "..." }
}
```

---

## 5. Campos editables

> Lista viva siempre disponible en `GET /schema` → sección `write_back`.

### 5.1 Cabecera (`ticket`)

`status`, `priority`, `length_class`, `vin`, `vehicle_info`, `seller_notes`, `block_notes`,
`notes`, `is_venta_concreta`, `conversion_status`, `duplicate_label`, `sender_name`,
`sender_phone`, `client_phone`.

### 5.2 Detalle (`items[]`, requiere `id`)

`parsed_description`, `quantity`, `status`, `source`, `brand`, `cost_price`, `selling_price`,
`supplier_code`, `codigo_distrimia`, `codigo_oem`, `codigo_fabrica`, `validity_status`,
`validity_expires_at`, `estimated_delivery`, `seller_note`, `internal_note`, `pedido_excluded`,
`control_group`, `audit_code_type`, `alternative_confirmed`, `confirmed_alternative_id`,
`item_order`.

### 5.3 NO editables (se ignoran)

`id`, `k_number`, `group_code`, `raw_text`, `putix_ref`, `ticket_id`, `parent_ticket_id`,
`assigned_to`, `created_by`, `updated_by`, `created_at`, `updated_at`, `sla_*`, `lock_*`.

---

## 6. Valores permitidos (enums relevantes)

| Campo | Valores |
|---|---|
| `ticket.status` | pending, pending_review, in_progress, ready, pedido, closed, cancelled, en_revision, reenviado |
| `ticket.priority` | low, normal, high, urgent |
| `ticket.length_class` | short, medium, long |
| `ticket.conversion_status` | positive, negative, pending |
| `ticket.duplicate_label` | dup_positive, dup_neutral, dup_negative |
| `items.status` | positive, negative, pending_info, no_registra, no_registra_verificar |
| `items.source` | importadora, almacen, distrimia |
| `items.validity_status` | vigente, vencido |
| `items.audit_code_type` | codigo_distrimia_con_oem, sin_oem, sin_oem_referencial, sin_codigo |
| `items.control_group` | A, B |

---

## 7. Errores

| HTTP | code | Cuándo |
|---|---|---|
| 400 | `EMPTY_UPDATE` | No se envió `ticket` ni `items` con contenido |
| 400 | `VALIDATION_ERROR` | Enum inválido / ítem sin `id` / ítem que no pertenece al ticket. Ver `validation_errors[]` |
| 404 | `NOT_FOUND` | El ticket no existe |
| 409 | `TICKET_NOT_SYNCABLE` | El ticket no está en un estado sincronizable |
| 401 | `API_KEY_MISSING` / `API_KEY_INVALID` | Problema con la API Key |

Formato:
```json
{ "error": "mensaje", "code": "VALIDATION_ERROR", "validation_errors": ["items[0]: falta \"id\" del item"] }
```

---

## 8. Ejemplo cURL

```bash
curl -X PATCH \
  -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "ticket": { "seller_notes": "ok", "status": "ready" },
        "items":  [ { "id": "<ITEM_ID>", "selling_price": 18.5 } ]
      }' \
  "$BASE/api/integrations/v1/tickets/<TICKET_ID>"
```

---

## 9. Flujo recomendado para PUTIX

1. `GET /tickets?status=pending,pending_review,in_progress,ready&updated_since=<lastSyncAt>`
2. Por cada ticket, completar la información en su etapa.
3. `PATCH /tickets/:id` con los campos de cabecera y/o los `items` (con su `id`) a actualizar.
4. Revisar `updated` e `ignored_fields` en la respuesta para confirmar qué se aplicó.

---

## 10. A confirmar con Mini Web

`status` es editable por ahora (validando solo el enum, sin aplicar las reglas internas de
transición). Confirmar si PUTIX debe poder cambiar `status` o si debe ser de solo lectura.
