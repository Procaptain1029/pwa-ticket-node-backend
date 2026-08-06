# Mini Web ↔ PUTIX — API de Integración v1

Documento de referencia para el equipo **PUTIX**. Describe cómo leer y actualizar los tickets
(proformas) de la Mini Web de Distrimia.

> **Mini Web es la fuente de verdad de la proforma.** PUTIX lee los tickets mediante *polling*
> y puede escribir de vuelta (write‑back) los campos editables de la cabecera y el detalle.

---

## 1. Autenticación

Todas las llamadas requieren el header:

```
X-API-Key: <SU_API_KEY>
```

- La API Key se entrega por un canal seguro (no está en este documento).
- Si falta o es inválida se responde `401`.

---

## 2. Base URL

```
<BACKEND_PUBLIC_URL>/api/integrations/v1
```

Ejemplo en producción: `https://api.distrimia.com/api/integrations/v1`
(en desarrollo: `http://localhost:3001/api/integrations/v1`).

---

## 3. Modelo de sincronización

| Concepto | Valor |
|---|---|
| Estrategia | Polling (sin webhooks en esta fase) |
| Intervalo recomendado | 60 segundos |
| Ventana de recuperación | `lastSyncAt = ahora − 24h` (para no perder cambios) |
| Filtro delta | `updated_since` (ISO‑8601) en `GET /tickets` |
| Estados sincronizables | `pending`, `pending_review`, `in_progress`, `ready` |

Solo esos 4 estados se consideran en el ciclo de sincronización y de escritura.

---

## 4. Endpoints

Resumen:

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/schema` | Catálogo de campos, enums, ejemplo y reglas de write‑back |
| GET | `/health` | Estado del servicio y estadísticas |
| GET | `/tickets` | Listado paginado con filtros y delta |
| GET | `/tickets/:id` | Ticket completo (ítems, alternativas, SLA, etc.) |
| GET | `/tickets/:id/blocks` | Bloques de texto generados |
| PATCH | `/tickets/:id` | **Write‑back**: actualiza cabecera y/o detalle |
| PUT | `/tickets/:id` | Alias de PATCH |
| GET | `/users` | Catálogo de usuarios Mini Web (para asignar en PUTIX) |
| GET | `/users/:id` | Detalle de un usuario |

---

### 4.1 GET `/schema`

Devuelve el contrato completo: campos de ticket/ítem/alternativa, `enums`, un `sample_payload`
y la sección `write_back` (campos editables + ejemplo). **Codifiquen contra este endpoint**, no
contra una lista fija.

---

### 4.2 GET `/health`

```json
{
  "status": "ok",
  "api_version": "v1",
  "api_key_configured": true,
  "sync": { "strategy": "polling", "delta_param": "updated_since", "recommended_interval_seconds": 60 },
  "stats": { "total_tickets": 1234, "updated_last_24h": 57, "...": "..." }
}
```

---

### 4.3 GET `/tickets` — listado / polling

**Query params:**

| Param | Tipo | Descripción |
|---|---|---|
| `page` | int | Página (default 1) |
| `limit` | int | Tamaño de página (default 50, máx 100) |
| `status` | string | Uno o varios separados por coma. Ej: `pending,in_progress` |
| `updated_since` | ISO‑8601 | Solo tickets modificados desde esa fecha (delta) |
| `created_since` | ISO‑8601 | Solo tickets creados desde esa fecha (backfill) |
| `group_code` | string | Filtra por grupo |
| `assigned_to` | uuid | Filtra por vendedor asignado |
| `k_number` | string | Búsqueda parcial por #K |
| `entry_type` | enum | `manual` \| `express` \| `audio` \| `putix_c0` |
| `sort_order` | `asc`\|`desc` | Orden por `updated_at` (default `desc`) |

**Ejemplo de polling delta (ventana 24h):**

```
GET /tickets?status=pending,pending_review,in_progress,ready&updated_since=2026-07-24T09:00:00Z
```

**Respuesta:**

```json
{
  "api_version": "v1",
  "tickets": [ { "id": "...", "k_number": "K000123", "status": "in_progress", "updated_at": "..." } ],
  "pagination": { "page": 1, "limit": 50, "total": 120, "total_pages": 3 },
  "filters_applied": { "status": "in_progress", "updated_since": "...", "created_since": null }
}
```

> El listado es liviano (sin ítems). Para el detalle completo usar `GET /tickets/:id`.

---

### 4.4 GET `/tickets/:id` — detalle completo

Devuelve el ticket con `items` (cada uno con sus `alternatives`), `extensions`,
`forwarding_log`, `attachments`, `sla`, `quote_total` y, salvo que se indique lo contrario,
los `blocks` de texto generados.

También incluye `coincidences`, con las referencias directas a los tickets marcados como
coincidentes:

```json
{
  "ticket": {
    "duplicate_label": "dup_positive",
    "coincidence_count": 1
  },
  "coincidences": [
    {
      "id": "uuid-del-ticket",
      "k_number": "K001800",
      "status": "closed",
      "group_code": "0217",
      "created_at": "2026-06-20T10:00:00.000Z",
      "similarity": 0.85,
      "label": "dup_positive"
    }
  ]
}
```

Query params opcionales: `include_blocks=false`, `include_attachment_urls=false`.

---

### 4.5 GET `/tickets/:id/blocks`

Solo los bloques de texto generados (proforma cliente, pedido, control A/B, por proveedor, etc.).

---

### 4.6 PATCH `/tickets/:id` — Write‑back (cabecera + detalle)

Permite a PUTIX actualizar los campos editables del ticket (**cabecera**) y de sus ítems
(**detalle**).

**Reglas clave**

1. **Lista blanca (allow‑list):** solo se aplican los campos editables (ver §5). Cualquier
   PK, FK o identificador de integridad que se envíe se **ignora** y se reporta en
   `ignored_fields`. No es un error enviarlos, simplemente no se aplican.
2. **Solo estados sincronizables:** si el ticket está en `pedido`, `closed`, `cancelled`,
   `en_revision` o `reenviado`, la llamada devuelve `409 TICKET_NOT_SYNCABLE`.
3. **Ciclo de vida de ítems según estado** (confirmado con Distrimia):
   - crear (sin `id`, opcional `client_ref`) → solo `in_progress`
   - eliminar (`_delete: true`) → solo `in_progress`
   - excluir (`pedido_excluded: true`) → `in_progress` o `pedido`
   - en `pedido` no se elimina físicamente; solo se excluye
4. Al aplicar el cambio se refresca `updated_at`, por lo que el ticket aparecerá en el
   siguiente `updated_since`.
5. Las creaciones devuelven el `id` generado en `updated.items_created` correlacionado con `client_ref`.

**Body:**

```json
{
  "ticket": {
    "status": "ready",
    "seller_notes": "Confirmado por PUTIX",
    "vehicle_info": { "marca": "CHEVROLET", "modelo": "LUV", "anio": "2004" }
  },
  "items": [
    { "id": "<uuid-item>", "selling_price": 18.5, "supplier_code": "IMP-001", "status": "positive" },
    { "client_ref": "tmp-1", "parsed_description": "Filtro de aceite", "quantity": 1 },
    { "id": "<uuid-eliminar>", "_delete": true },
    { "id": "<uuid-excluir>", "pedido_excluded": true }
  ]
}
```

Ambas secciones son opcionales, pero debe enviarse al menos una con contenido.

**Respuesta 200:**

```json
{
  "api_version": "v1",
  "updated": {
    "ticket_fields": ["status", "seller_notes", "vehicle_info"],
    "items_updated": 2,
    "items_created": [{ "client_ref": "tmp-1", "id": "uuid-nuevo", "index": 1 }],
    "items_deleted": ["uuid-eliminar"],
    "items_excluded": ["uuid-excluir"]
  },
  "ignored_fields": { "ticket": [], "items": {} },
  "ticket": { "...": "payload completo actualizado (igual que GET /tickets/:id)" }
}
```

Documentación detallada del ciclo de vida: `PUTIX-ITEMS-LIFECYCLE-v1.md`.

---

## 5. Campos editables (write‑back)

> La lista viva y siempre actualizada está en `GET /schema` → `write_back`.

### 5.1 Cabecera (`ticket`)

`status`, `priority`, `length_class`, `vin`, `vehicle_info`, `seller_notes`, `block_notes`,
`notes`, `is_venta_concreta`, `conversion_status`, `duplicate_label`, `sender_name`,
`sender_phone`, `client_phone`, `assigned_to` (uuid de usuario Mini Web activo, o `null`).

### 5.2 Detalle (`items[]`) — requiere `id`

`parsed_description`, `quantity`, `status`, `source`, `brand`, `cost_price`, `selling_price`,
`supplier_code`, `codigo_distrimia`, `codigo_oem`, `codigo_fabrica`, `validity_status`,
`validity_expires_at`, `estimated_delivery`, `seller_note`, `internal_note`, `pedido_excluded`,
`control_group`, `audit_code_type`, `alternative_confirmed`, `confirmed_alternative_id`,
`item_order`.

### 5.3 NO editables (se ignoran)

`id`, `k_number`, `group_code`, `raw_text`, `putix_ref`, `ticket_id`, `parent_ticket_id`,
`created_by`, `updated_by`, `created_at`, `updated_at`, campos `sla_*`,
campos `lock_*` y cualquier otro identificador de integridad.

---

## 6. Enums

| Enum | Valores |
|---|---|
| `ticket_status` | pending, pending_review, in_progress, ready, pedido, closed, cancelled, en_revision, reenviado |
| `item_status` | positive, negative, pending_info, no_registra, no_registra_verificar |
| `length_class` | short, medium, long |
| `priority` | low, normal, high, urgent |
| `validity_status` | vigente, vencido |
| `item_source` | importadora, almacen, distrimia |
| `duplicate_label` | dup_positive, dup_neutral, dup_negative |
| `audit_code_type` | codigo_distrimia_con_oem, sin_oem, sin_oem_referencial, sin_codigo |
| `conversion_status` | positive, negative, pending |
| `control_group` | A, B |

---

## 7. Histórico de tickets cerrados

Para el flujo interno de PUTIX que requiere **todos los tickets cerrados desde el inicio de la
Mini Web**, usar el listado con `status=closed`:

```
GET /tickets?status=closed&sort_order=asc&limit=100&page=1
GET /tickets?status=closed&sort_order=asc&limit=100&page=2
...
```

Backfill incremental por fecha de creación:

```
GET /tickets?status=closed&sort_order=asc&created_since=2025-01-01T00:00:00Z&limit=100
```

El detalle completo de cada uno se obtiene con `GET /tickets/:id`.

Para un **sync inicial completo de todo el historial** (todos los estados), omitir
`updated_since` y `status`, y recorrer todas las páginas:

```
GET /tickets?sort_order=asc&limit=100&page=1
GET /tickets?sort_order=asc&limit=100&page=2
...
```

La respuesta indica `pagination.total_pages`. PUTIX debe continuar hasta esa página. No existe
una respuesta ilimitada; el máximo es 100 tickets por página para proteger el servicio.
Después del sync inicial, continuar con el polling normal usando `updated_since`.

---

## 7bis. Sincronización de usuarios

Para asignar responsables al tomar un ticket en PUTIX, sincronizar el catálogo:

```
GET /users?is_active=true&updated_since=<lastSync>
```

Luego asignar con write-back:

```json
{ "ticket": { "assigned_to": "<user-uuid>", "status": "in_progress" } }
```

Documentación completa: `PUTIX-USERS-SYNC-v1.md`.

---

## 8. Códigos de error

| HTTP | code | Significado |
|---|---|---|
| 401 | `API_KEY_MISSING` | Falta el header `X-API-Key` |
| 401 | `API_KEY_INVALID` | API Key incorrecta |
| 500 | `API_KEY_NOT_CONFIGURED` | El servidor no tiene la key configurada (contactar a Mini Web) |
| 404 | `NOT_FOUND` | Ticket inexistente |
| 400 | `EMPTY_UPDATE` | No se envió `ticket` ni `items` con contenido |
| 400 | `VALIDATION_ERROR` | Enum inválido, ítem sin `id`, ítem que no pertenece al ticket, etc. (ver `validation_errors`) |
| 409 | `TICKET_NOT_SYNCABLE` | El ticket no está en un estado sincronizable |

Formato de error:

```json
{ "error": "mensaje legible", "code": "VALIDATION_ERROR", "validation_errors": ["..."] }
```

---

## 9. Ejemplos rápidos (cURL)

```bash
# Listado delta
curl -H "X-API-Key: $KEY" \
  "$BASE/tickets?status=pending,in_progress,ready&updated_since=2026-07-24T09:00:00Z"

# Detalle
curl -H "X-API-Key: $KEY" "$BASE/tickets/<TICKET_ID>"

# Write-back
curl -X PATCH -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"ticket":{"seller_notes":"ok"},"items":[{"id":"<ITEM_ID>","selling_price":18.5}]}' \
  "$BASE/tickets/<TICKET_ID>"
```

---

## 10. Punto a confirmar con Mini Web

Actualmente el campo `status` **sí** es editable vía write‑back (validando solo el enum; no se
aplican las reglas internas de transición de la Mini Web). Confirmar con el equipo Distrimia si
PUTIX debe poder cambiar el `status` o si debe quedar de solo lectura para PUTIX.
