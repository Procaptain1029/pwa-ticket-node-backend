# Mini Web ↔ PUTIX — Sincronización de Usuarios v1

Documento para el equipo **PUTIX**. Describe el endpoint para sincronizar los usuarios de
Mini Web hacia PUTIX, de modo que puedan **asignar responsables** al tomar un ticket.

---

## 1. Por qué existe

En PUTIX se deben asignar usuarios en sus respectivos campos para tomar el ticket.
Mini Web es la **fuente de verdad** de los usuarios (vendedores, operadores, etc.).

PUTIX debe:
1. Sincronizar el catálogo con `GET /users`
2. Usar el `id` del usuario Mini Web en `ticket.assigned_to` vía write-back

---

## 2. Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/integrations/v1/users` | Listado paginado / delta de usuarios |
| GET | `/api/integrations/v1/users/:id` | Detalle de un usuario |
| PATCH | `/api/integrations/v1/tickets/:id` | Asignar con `ticket.assigned_to` |

Auth: header `X-API-Key: <SU_API_KEY>`

---

## 3. GET `/users` — catálogo / polling

### Query params

| Param | Tipo | Default | Descripción |
|---|---|---|---|
| `page` | int | 1 | Página |
| `limit` | int | 100 | Máx 200 |
| `is_active` | `true` \| `false` \| `all` | `true` | Solo activos por defecto |
| `role` | string | — | Uno o varios: `seller`, `seller,dispatcher` |
| `updated_since` | ISO-8601 | — | Delta (mismo patrón que tickets) |
| `email` | string | — | Búsqueda parcial |
| `sort_order` | `asc` \| `desc` | `asc` | Orden por `updated_at` |

### Ejemplo de sincronización

```
GET /users?is_active=true&updated_since=2026-07-27T12:00:00Z
GET /users?is_active=true&role=seller&limit=200
```

### Respuesta

```json
{
  "api_version": "v1",
  "users": [
    {
      "id": "a1b2c3d4-....",
      "email": "vendedor@distrimia.com",
      "full_name": "Juan Pérez",
      "role": "seller",
      "is_active": true,
      "avatar_url": null,
      "created_at": "2025-01-10T10:00:00.000Z",
      "updated_at": "2026-07-20T15:30:00.000Z"
    }
  ],
  "pagination": { "page": 1, "limit": 100, "total": 42, "total_pages": 1 },
  "filters_applied": { "role": null, "is_active": true, "updated_since": "...", "email": null }
}
```

### Campos

| Campo | Uso en PUTIX |
|---|---|
| `id` | **Clave** — usar en `ticket.assigned_to` |
| `email` | Identificación / matching |
| `full_name` | Mostrar en UI |
| `role` | Filtrar vendedores / despachadores |
| `is_active` | No asignar inactivos |
| `updated_at` | Polling delta |

Roles posibles: `operator`, `dispatcher`, `seller`, `aux`, `admin`.

---

## 4. GET `/users/:id`

```json
{
  "api_version": "v1",
  "user": { "id": "...", "email": "...", "full_name": "...", "role": "seller", "is_active": true, "..." : "..." }
}
```

`404` si no existe.

---

## 5. Asignar usuario al ticket (write-back)

Una vez sincronizado el catálogo, al **tomar** el ticket:

```
PATCH /api/integrations/v1/tickets/:id
X-API-Key: <SU_API_KEY>
Content-Type: application/json
```

```json
{
  "ticket": {
    "assigned_to": "a1b2c3d4-....",
    "status": "in_progress"
  }
}
```

- `assigned_to` debe ser un `users.id` **activo** de Mini Web.
- Mini Web aplica el mismo comportamiento que el botón **Tomar**:
  - asigna (`assigned_to` + `assigned_at`)
  - bloquea el ticket (`locked_by`, lock)
  - inicia el SLA
  - si el status era `pending` / `pending_review` / `en_revision`, pasa a `in_progress`
- En la respuesta, `updated.take_applied: true` confirma que se aplicó Tomar.
- Para desasignar: `"assigned_to": null` (también libera el lock).
- Si el usuario no existe o está inactivo → `400 VALIDATION_ERROR`.

---

## 6. Flujo recomendado

1. Polling de usuarios: `GET /users?is_active=true&updated_since=<lastUserSync>`
2. Guardar catálogo local en PUTIX (id, nombre, email, role)
3. En la pantalla de toma de ticket, mostrar el selector con esos usuarios
4. Al confirmar: `PATCH /tickets/:id` con `assigned_to` (+ `status` si aplica)
5. Polling de tickets como hasta ahora

---

## 7. Ejemplo cURL

```bash
# Sync usuarios activos
curl -H "X-API-Key: $KEY" "$BASE/api/integrations/v1/users?is_active=true&limit=200"

# Tomar ticket asignando vendedor
curl -X PATCH -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"ticket":{"assigned_to":"<USER_UUID>","status":"in_progress"}}' \
  "$BASE/api/integrations/v1/tickets/<TICKET_ID>"
```
