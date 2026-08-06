# Mini Web ↔ PUTIX — Ciclo de vida de ítems (write-back) v1

Documento para el equipo **PUTIX**. Extiende `PATCH /api/integrations/v1/tickets/:id`
para **agregar**, **eliminar** y **excluir** ítems según el estado del ticket
(flujo confirmado con Andrés / Distrimia).

---

## 1. Reglas por estado

| Operación | `in_progress` | `pedido` | Otros estados |
|---|---|---|---|
| Actualizar campos de un ítem existente | Sí | No (solo excluir) | Sí (estados sincronizables: pending / pending_review / ready) |
| Agregar ítem nuevo (sin `id`) | Sí | No | No |
| Eliminar ítem (`_delete: true`) | Sí | No | No |
| Excluir ítem (`pedido_excluded: true`) | Sí | Sí (única baja) | No |

- En **pedido** no se elimina físicamente: se excluye para reportes.
- Si el estado no permite la operación → `400 VALIDATION_ERROR`.
- Tickets en `pedido` ahora son escribibles, pero **solo** para `pedido_excluded` en ítems (no cabecera).

---

## 2. Body de ejemplo

```
PATCH /api/integrations/v1/tickets/:id
X-API-Key: <SU_API_KEY>
Content-Type: application/json
```

```json
{
  "items": [
    { "id": "uuid-existente", "selling_price": 18.5 },
    { "client_ref": "tmp-1", "parsed_description": "Filtro de aceite", "quantity": 1 },
    { "id": "uuid-a-eliminar", "_delete": true },
    { "id": "uuid-a-excluir", "pedido_excluded": true }
  ]
}
```

### Crear ítem (solo `in_progress`)

- Sin `id`.
- Requiere `parsed_description` (o `raw_line`).
- Opcional: `client_ref` (su id temporal) + campos editables (`quantity`, `status`, precios, etc.).
- Mini Web genera el `id` y lo devuelve correlacionado con `client_ref`.

### Eliminar ítem (solo `in_progress`)

```json
{ "id": "uuid-a-eliminar", "_delete": true }
```

- No se puede dejar el ticket sin ítems (debe quedar ≥ 1).
- Alternativas del ítem se borran en cascada (FK).

### Excluir ítem (`in_progress` o `pedido`)

```json
{ "id": "uuid-a-excluir", "pedido_excluded": true }
```

En `pedido` es la **única** operación de ítem permitida.

---

## 3. Respuesta

```json
{
  "api_version": "v1",
  "updated": {
    "ticket_fields": [],
    "items_updated": 2,
    "items_created": [
      { "client_ref": "tmp-1", "id": "uuid-nuevo-generado", "index": 1 }
    ],
    "items_deleted": ["uuid-a-eliminar"],
    "items_excluded": ["uuid-a-excluir"],
    "take_applied": false,
    "release_applied": false
  },
  "ignored_fields": { "ticket": [], "items": {} },
  "ticket": { "...": "payload completo actualizado" }
}
```

**Importante:** usen `updated.items_created` para guardar el `id` Mini Web contra su `client_ref`. Sin eso no podrán actualizar/eliminar/excluir ese ítem después.

`index` es la posición (0-based) del ítem dentro del array `items` enviado.

El payload completo (`ticket`) ya incluye el ítem nuevo con su `id`.

---

## 4. Errores relevantes

| HTTP | code | Cuándo |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Estado incorrecto para create/delete/exclude, falta descripción al crear, borrar el último ítem, etc. |
| 409 | `TICKET_NOT_SYNCABLE` | Ticket fuera de estados escribibles |

Ejemplo:

```json
{
  "error": "Errores de validación en la solicitud",
  "code": "VALIDATION_ERROR",
  "validation_errors": [
    "items[1]: agregar ítems solo está permitido en estado in_progress (actual: ready)"
  ]
}
```

---

## 5. Ejemplo cURL

```bash
# Crear + excluir en in_progress
curl -X PATCH -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{
    "items": [
      { "client_ref": "tmp-filtro", "parsed_description": "Filtro de aceite", "quantity": 1 },
      { "id": "<ITEM_ID>", "pedido_excluded": true }
    ]
  }' \
  "$BASE/api/integrations/v1/tickets/<TICKET_ID>"

# En pedido: solo excluir
curl -X PATCH -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{ "items": [ { "id": "<ITEM_ID>", "pedido_excluded": true } ] }' \
  "$BASE/api/integrations/v1/tickets/<TICKET_ID>"
```
