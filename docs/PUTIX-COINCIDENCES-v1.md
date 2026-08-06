# Mini Web ↔ PUTIX — Referencias de Coincidencias v1

Documento para el equipo PUTIX sobre la identificación directa de tickets duplicados.

## Endpoint

```
GET /api/integrations/v1/tickets/:id
X-API-Key: <SU_API_KEY>
```

Además de `ticket.duplicate_label` y `ticket.coincidence_count`, la respuesta incluye:

```json
{
  "ticket": {
    "id": "uuid-ticket-actual",
    "k_number": "K001850",
    "duplicate_label": "dup_positive",
    "coincidence_count": 1
  },
  "coincidences": [
    {
      "id": "uuid-del-ticket-coincidente",
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

PUTIX puede usar `coincidences[].id` o `coincidences[].k_number` para enlazar directamente al
ticket anterior, sin buscarlo nuevamente por vehículo.

`coincidence_count` corresponde al número de elementos de `coincidences`.

Si no hay coincidencias registradas:

```json
{
  "ticket": {
    "coincidence_count": 0
  },
  "coincidences": []
}
```

## Sync inicial del historial

Para que el buscador local de PUTIX pueda encontrar tickets históricos, hacer una carga inicial
completa omitiendo `updated_since` y `status`:

```
GET /api/integrations/v1/tickets?sort_order=asc&limit=100&page=1
GET /api/integrations/v1/tickets?sort_order=asc&limit=100&page=2
...
```

Continuar hasta `pagination.total_pages`. El máximo es 100 por página; no hay una respuesta
ilimitada.

Para cada ticket del listado, obtener su detalle con:

```
GET /api/integrations/v1/tickets/:id
```

Después de completar el histórico, continuar con el polling normal:

```
GET /api/integrations/v1/tickets?updated_since=<lastSyncAt>&limit=100&page=1
```

## Ítems agregados o eliminados

El write-back ya soporta ciclo de vida de ítems según estado:

- **crear** (sin `id`, opcional `client_ref`) → solo `in_progress`
- **eliminar** (`_delete: true`) → solo `in_progress`
- **excluir** (`pedido_excluded: true`) → `in_progress` o `pedido`

Ver documentación completa: `PUTIX-ITEMS-LIFECYCLE-v1.md`.
