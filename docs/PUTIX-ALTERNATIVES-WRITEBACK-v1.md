# Mini Web ↔ PUTIX — Alternativas en write-back v1

Documento para el equipo **PUTIX**. Extiende `PATCH /api/integrations/v1/tickets/:id`
para que el array `alternatives` de cada ítem **sí se persista** en Mini Web
(ya no aparece en `ignored_fields`).

---

## 1. Comportamiento

- `alternatives` usa **replace semantics**: el array enviado **reemplaza** el set
  completo de alternativas del ítem.
- `[]` vacía todas las alternativas del ítem.
- Permitido en estados sincronizables (`pending`, `pending_review`, `in_progress`, `ready`).
- En `pedido` **no** se actualizan alternativas (solo `pedido_excluded`).
- Campos por alternativa:
  - `brand` (requerido)
  - `selling_price`, `cost_price`, `source`, `supplier_code`, `estimated_delivery`, `notes`
  - `client_ref` (opcional, para correlacionar el `id` generado)

---

## 2. Ejemplo

```json
{
  "items": [
    {
      "id": "uuid-item-existente",
      "selling_price": 18.5,
      "brand": "MANN",
      "alternatives": [
        { "client_ref": "alt-1", "brand": "WIX", "selling_price": 15.0, "cost_price": 10.0, "source": "importadora" },
        { "client_ref": "alt-2", "brand": "BOSCH", "selling_price": 16.5, "notes": "alternativa" }
      ],
      "confirmed_alternative_client_ref": "alt-2"
    }
  ]
}
```

También se puede enviar `alternatives` al **crear** un ítem (sin `id`):

```json
{
  "items": [
    {
      "client_ref": "tmp-1",
      "parsed_description": "Filtro de aceite",
      "quantity": 1,
      "alternatives": [
        { "client_ref": "alt-a", "brand": "WIX", "selling_price": 15.0 }
      ]
    }
  ]
}
```

---

## 3. Respuesta

```json
{
  "updated": {
    "items_updated": 1,
    "alternatives_updated": [
      {
        "item_id": "uuid-item-existente",
        "item_client_ref": null,
        "alternatives": [
          { "client_ref": "alt-1", "id": "uuid-alt-generado-1", "brand": "WIX" },
          { "client_ref": "alt-2", "id": "uuid-alt-generado-2", "brand": "BOSCH" }
        ]
      }
    ]
  }
}
```

Guarden `alternatives[].id` contra su `client_ref` para operar después.

### Confirmación

Al reemplazar alternativas se resetea la confirmación previa. Opciones:

1. Enviar `confirmed_alternative_client_ref` en el mismo PATCH (apunta a un `client_ref` del array).
2. O en un segundo PATCH, con el `id` real:
   ```json
   { "items": [{ "id": "uuid-item", "alternative_confirmed": true, "confirmed_alternative_id": "uuid-alt" }] }
   ```

---

## 4. Notas

- `alternatives` ya **no** debe aparecer en `ignored_fields`.
- El payload completo (`ticket.items[].alternatives`) refleja el set nuevo.
- Documentación general de write-back: `PUTIX-WRITEBACK-v1.md` / `PUTIX-ITEMS-LIFECYCLE-v1.md`.
