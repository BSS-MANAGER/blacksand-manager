# BLACK SAND Manager

Sistema central de gestión multicanal — Shopify · Mercado Libre (MLC) · Meta
(solo feed de catálogo). Aplicación de escritorio (Electron + React +
TypeScript) que centraliza en tu PC el catálogo, el inventario y (en fases
futuras) las ventas de la tienda, sincronizando con los canales de venta.

Este repositorio implementa las **Fases 1 a 3, más 2b**, del plan descrito en
`docs/BLACK_SAND_Manager_Especificacion_Tecnica.md`: conexión segura a
Shopify y Mercado Libre, importación y edición de catálogo/inventario con
push real a ambos canales, descuento automático de stock — tanto cuando
llega un pedido nuevo a un canal (sondeo periódico) como al registrar una
venta de mostrador — reflejado en todos los canales donde el producto está
mapeado, y publicación de productos de Shopify en Mercado Libre para que el
catálogo quede emparejado por SKU en ambos canales.

## Requisitos previos

- Windows 10/11 (entorno de desarrollo objetivo; también corre en macOS/Linux
  para desarrollo, ver J.1).
- [Node.js 20+](https://nodejs.org) y [pnpm](https://pnpm.io) (`corepack enable` o `npm i -g pnpm`).
- Una tienda Shopify donde puedas crear una **Custom App** (Configuración → Apps y canales de venta → Desarrollar apps).
- Una cuenta de vendedor de Mercado Libre y una app registrada en [developers.mercadolibre.com/devcenter](https://developers.mercadolibre.com.ar/devcenter).

## Instalación

```bash
pnpm install
cp .env.example .env
cp packages/db/.env.example packages/db/.env
```

## Base de datos (una vez, y cada vez que cambie el esquema)

```bash
pnpm db:generate      # genera el cliente de Prisma
pnpm --filter @blacksand/db migrate   # crea/actualiza packages/db/prisma/dev.db
node scripts/build-template-db.mjs    # copia esa plantilla a apps/desktop/resources
```

> Si `prisma migrate dev` te pide un nombre para la migración (pasa la
> primera vez que corres esto después de actualizar a Fase 2b, que agregó
> la tabla `MeliCategoryGroupMapping`), escribe algo como
> `add_meli_category_mapping` y presiona Enter — no hace falta nada más.

La app de escritorio copia esa plantilla a la carpeta de datos del usuario
(`%APPDATA%/BLACK SAND Manager` en Windows) la primera vez que arranca — ver
`apps/desktop/src/main/db-bootstrap.ts`. Nunca se escribe dentro de la
carpeta de instalación del programa.

## Correr en desarrollo

```bash
pnpm dev:desktop
```

Esto levanta Vite para el renderer y Electron apuntando a él con recarga en
caliente. La primera vez, ve a **Configuración** dentro de la app para
conectar tus canales (ver abajo).

## Conectar Shopify

> ⚠️ Shopify descontinuó la creación de apps personalizadas nuevas desde el
> admin de la tienda (`Configuración → Desarrollar apps`). Ahora se crean
> desde el **Dev Dashboard**, un panel aparte, y en vez de un token fijo
> `shpat_...` entregan un **Client ID + Client Secret**: el access token real
> (dura 24h) se obtiene con *Client Credentials Grant* y BLACK SAND Manager
> lo renueva solo (`packages/connectors/shopify/src/oauth.ts`).

1. Ve a **dev.shopify.com/dashboard** e inicia sesión con la cuenta de tu
   tienda. Crea una app y dale un nombre (ej. "BLACK SAND Manager").
2. Dentro de la app, haz clic en **"Configure Admin API scopes"** y activa
   como mínimo estos *scopes* (sección L.1): `read_products`,
   `read_inventory`, `read_orders`. Guarda.
3. Haz clic en **"Install app"** y selecciona tu tienda. Después de
   instalar, ve a **Configuración → Credenciales** dentro de la app: ahí
   están el **Client ID** y el **Secreto** (`shpss_...`, botón de ojo para
   revelarlo). No hace falta copiarlos "antes de que desaparezcan" — a
   diferencia del viejo token, el Client ID/Secret quedan siempre visibles
   ahí (con opción de "Rotar" si alguna vez se filtran).
4. En BLACK SAND Manager → Configuración → Shopify, ingresa el dominio
   (`tu-tienda.myshopify.com`), la versión de API (ej. `2026-01`), el
   Client ID y el Client Secret. Al guardar, la app pide un access token de
   prueba contra la API real (falla rápido si algo está mal) y guarda el
   Client Secret en el Credential Manager de Windows (nunca en un archivo).

## Conectar Mercado Libre

> ⚠️ Mercado Libre exige que el **Redirect URI** sea una dirección **pública
> real** — rechaza tanto `http://localhost...` como `https://localhost...`
> con el error "La dirección debe ser válida". A diferencia de Shopify, no
> hay forma de que BLACK SAND Manager levante un servidor local que capture
> el `code` automáticamente. Por eso el redirect_uri apunta a cualquier
> página https real que ya existe (por defecto, el propio sitio de Mercado
> Libre) y, después de autorizar, **tú copias el código de la URL y lo
> pegas en la app** — es un paso extra, pero no requiere crear ningún
> servidor, dominio ni cuenta adicional.

1. En [developers.mercadolibre.com.ar/devcenter](https://developers.mercadolibre.com.ar/devcenter),
   crea una aplicación. Como **Redirect URI** usa una dirección https real y
   estable — por ejemplo `https://www.mercadolibre.cl/` (el valor por
   defecto en Configuración) o tu propio sitio (`https://www.tu-tienda.cl/`).
   No hace falta que esa página "haga" nada especial: solo se usa para leer
   el código de su URL después. Debe coincidir exactamente con lo que
   pongas en BLACK SAND Manager.
2. Copia el **Client ID** y **Client Secret** a BLACK SAND Manager →
   Configuración → Mercado Libre → "Guardar credenciales".
3. Haz clic en **"Conectar cuenta"**: se abre tu navegador para autorizar la
   app con tu cuenta vendedora de Mercado Libre.
4. Al aceptar, el navegador te lleva a la página que pusiste como Redirect
   URI, pero con parámetros pegados al final de la dirección, algo como
   `https://www.mercadolibre.cl/?code=TG-XXXXXXXX...&state=...`. **Copia esa
   URL completa desde la barra de direcciones** y pégala en el campo "URL
   (o código) tras autorizar" que aparece en BLACK SAND Manager, luego haz
   clic en **"Confirmar conexión"**. Ahí sí, BLACK SAND Manager intercambia
   ese código por el `access_token`/`refresh_token` y los guarda en la
   bóveda de credenciales.

## Meta / Facebook

Deshabilitado a propósito en Fase 1: Facebook/Instagram Shopping no está
disponible para cuentas de Chile desde agosto de 2023 (sección A.3 de la
especificación). El conector (`packages/connectors/meta`) solo sabe generar
un feed de catálogo para publicidad — llega activo en Fase 6.

## Primera importación

Con al menos un canal conectado, ve al **Dashboard** y usa "Importar de
Shopify" / "Importar de Mercado Libre". El importador empareja cada
producto por SKU o código de barras exacto contra tu catálogo central; los
casos ambiguos (o sin SKU) quedan en la pantalla **Conciliación** para que
los confirmes manualmente — nunca se fusionan solos (sección G.1).

## Editar catálogo y stock (Fase 2)

En **Productos**, cada variante es editable (SKU, precio, stock). Al hacer
clic en "Guardar y sincronizar" el cambio se escribe primero en la base
local y se empuja de inmediato a cada canal donde esa variante ya está
mapeada — no crea publicaciones nuevas en ningún canal.

## Pedidos y venta presencial (Fase 3)

- **Pedidos online**: cada `SYNC_POLLING_INTERVAL_MINUTES` (5 por defecto)
  la app revisa sola los pedidos nuevos de Shopify y Mercado Libre (mirando
  hacia atrás `ORDER_POLL_LOOKBACK_HOURS` horas — 24 por defecto, para no
  perder nada si el PC estuvo apagado) y descuenta el stock vendido en la
  base local y en el/los otro(s) canal(es) donde el producto está mapeado.
  El botón **"Revisar pedidos ahora"** en el Dashboard hace lo mismo al
  instante, sin esperar el sondeo. Un pedido con una línea sin SKU mapeado
  igual se registra, pero esa línea no descuenta stock — queda explícito en
  **Auditoría**.
- **Venta presencial**: la pantalla **Venta presencial** deja armar un
  carrito y registrar una venta de mostrador, que descuenta stock y lo
  empuja a **todos** los canales donde cada producto está mapeado. Todavía
  no hay login de vendedores — si quieres dejar constancia de quién vendió,
  anótalo en el campo de observaciones.

## Publicar productos de Shopify en Mercado Libre (Fase 2b)

Mercado Libre exige categoría y atributos específicos por categoría al
crear una publicación (no es un simple nombre+precio), así que en
**Publicar en ML** los productos de Shopify que todavía no existen en
Mercado Libre se agrupan por categoría (heredada del *product type* de
Shopify) y la categoría/atributos de Mercado Libre se confirman **una vez
por grupo**, no producto por producto:

1. En **Configuración → Publicar en Mercado Libre**, define una "Marca por
   defecto" — se usa cuando un producto no tiene marca/vendor propia en
   Shopify (Mercado Libre exige marca en casi todas las categorías).
2. En **Publicar en ML**, haz clic en "Revisar categoría" sobre un grupo:
   la app predice la categoría de Mercado Libre a partir del nombre de un
   producto del grupo (se puede buscar otra categoría a mano si la
   predicción no es la correcta), y muestra los atributos que esa
   categoría exige y que no se pueden inferir por producto (ej. "Línea",
   o cómo declarar que un producto no tiene GTIN/código de barras) — elige
   un valor y haz clic en "Confirmar mapeo de esta categoría".
3. Con la categoría confirmada, define cuántos productos publicar en el
   lote (recomendado: empezar con 2-3) y haz clic en "Publicar lote".
   Revisa en tu panel de Mercado Libre (mercadolibre.cl → Mis
   publicaciones) que el título, precio, foto y SKU se vean bien antes de
   publicar el resto del grupo.
4. Una vez publicado con el mismo SKU que tiene en Shopify, corre
   "Importar de Mercado Libre" en el Dashboard una vez más para que el
   importador lo empareje — a partir de ahí, la pantalla **Productos**
   muestra ese producto como una sola fila con ambos canales.

Un producto que falla (sin marca, sin imágenes en Shopify, o un rechazo
real de la API) queda visible en el resultado del lote con el motivo — no
tumba el resto del lote, y la próxima corrida vuelve a intentarlo (a menos
que ya se haya publicado, en cuyo caso deja de aparecer como candidato).

## Empaquetar para Windows

```bash
pnpm --filter @blacksand/desktop dist:win
```

Genera un instalador NSIS en `apps/desktop/release/`. Antes de distribuirlo
de verdad, configura firma de código (`CSC_LINK`/`CSC_KEY_PASSWORD`, sección
D.5/J.1) y decide una estrategia de actualizaciones automáticas con
`electron-updater` (ya incluido como dependencia, sin configurar todavía).

## Estructura del proyecto

```
blacksand-manager/
├── apps/desktop/            Electron + React (UI) — main, preload, renderer
├── packages/
│   ├── shared/              Tipos y esquemas Zod compartidos
│   ├── db/                  Esquema Prisma (SQLite) y repositorios
│   ├── core-domain/         Reglas de negocio (emparejamiento, stock)
│   ├── credentials/         Bóveda de credenciales (keytar + fallback dev)
│   ├── sync-engine/         Importador, sondeo, conciliación
│   └── connectors/
│       ├── shopify/         GraphQL Admin API (lectura, Fase 1)
│       ├── mercadolibre/    OAuth2 + REST (lectura, Fase 1)
│       └── meta/            Generador de feed de catálogo (sin publicar)
├── scripts/                 Utilidades de build (plantilla de BD, etc.)
└── docs/                    Especificación técnica completa y ADRs
```

## Qué sigue (Fase 4 en adelante)

Ver la sección H de `docs/BLACK_SAND_Manager_Especificacion_Tecnica.md` para
el plan completo. En resumen: Fase 4 agrega carritos abandonados (sujeto a
aprobación de *protected customer data* de Shopify) y correos de
recuperación; Fase 5, ficha de cliente, reportes/exportación a Excel y
auditoría ampliada; Fase 6, operaciones masivas y el feed de Meta para
publicidad. Publicar en la dirección inversa (productos que solo existen en
Mercado Libre, dados de alta en Shopify) no está implementado — se puede
evaluar más adelante con el mismo patrón de Fase 2b.

## Seguridad

Ningún token o client secret se guarda en texto plano ni se sube al
repositorio (ver `.gitignore` y `packages/credentials`). Si compartes este
código (por ejemplo en Git), **nunca** comitees un `.env` real ni el archivo
`dev-vault.enc.json` que pueda generarse en modo de desarrollo sin keytar.
