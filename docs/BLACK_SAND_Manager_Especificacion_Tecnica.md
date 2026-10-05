**BLACK SAND MANAGER**

Sistema central de gestión multicanal

*Shopify · Mercado Libre · Meta / Facebook*

Especificación técnica, análisis de viabilidad y plan de implementación por fases

Preparado para Bastián Castro · Chile · Septiembre 2026

**Resumen ejecutivo**

Este documento entrega el análisis de viabilidad, la arquitectura técnica y el plan de implementación por fases para BLACK SAND Manager: una aplicación de escritorio que centraliza en el PC del usuario la administración de productos, inventario, precios, clientes, ventas presenciales y pedidos de una tienda deportiva/airsoft/combate táctico, sincronizando esa información con Shopify, Mercado Libre y, de forma condicionada, Meta/Facebook.

**Hallazgo central:** Shopify y Mercado Libre (sitio Chile, MLC) tienen APIs oficiales completas, estables y públicamente documentadas que permiten automatizar productos, inventario, pedidos y notificaciones en tiempo real. Meta/Facebook es distinto: sus APIs de comercio existen, pero el

**canal de venta con catálogo (Facebook/Instagram Shopping, y por extensión la distribución de catálogo a Marketplace) está descontinuado para cuentas de Chile desde agosto de 2023**, y sigue así en 2026 según la documentación de soporte vigente y guías actualizadas para el mercado chileno. Además, la API de gestión de vendedores de Marketplace (\"Marketplace Partner Seller API\") está reservada a partners agregadores aprobados por Meta, no a comercios individuales. En consecuencia, Meta se incorpora a la arquitectura como conector opcional de catálogo para publicidad (Advantage+ / Conversions API) y no como canal transaccional con inventario y pedidos sincronizados --- ver sección A.3 y C para el detalle y las alternativas legítimas.

La arquitectura recomendada usa el PC del usuario como fuente central de verdad: una base de datos local (SQLite, con ruta de migración a PostgreSQL) almacena el catálogo maestro, el stock y las ventas; un motor de sincronización con cola, reintentos e idempotencia propaga los cambios hacia Shopify y Mercado Libre, y consume eventos de esos canales (webhooks cuando existen, sondeo/polling programado como respaldo) para mantener el stock consolidado sin sobreventa.

Siguiendo lo solicitado, este documento NO es una implementación completa. Cierra con una Fase 1 acotada: conexión segura a los tres canales, lectura de productos/inventario, base local, mapeo de IDs y un dashboard de sincronización de solo lectura --- la base que debe validarse antes de tocar módulos de escritura, ventas o carritos abandonados.

**Módulos contemplados**

Los 17 módulos solicitados se agrupan en tres franjas por dependencia técnica: los que sólo requieren lectura (disponibles desde la Fase 1), los que requieren escritura hacia los canales (Fase 2--3), y los que dependen de aprobaciones o servicios externos adicionales (Fase 4 en adelante).

  -------------------------------------------------------------------------------------------------------------------------------------------------------
  **\#**   **Módulo**                                   **Depende de**                                          **Disponible desde**
  -------- -------------------------------------------- ------------------------------------------------------- -----------------------------------------
  1        Dashboard general                            Lectura de todos los canales                            Fase 1

  2        Inventario central y movimientos             Base local + lectura de canales                         Fase 1 (lectura) / Fase 2 (edición)

  3        Ventas presenciales                          Motor de sincronización saliente                        Fase 3

  4        Productos y variantes                        Base local + mapeo de IDs                               Fase 1 (lectura) / Fase 2 (edición)

  5        Publicación/sincronización multicanal        Motor de sincronización                                 Fase 1 (estado) / Fase 2 (acción)

  6        Shopify (conector)                           Custom App + scopes                                     Fase 1

  7        Mercado Libre (conector)                     OAuth2 + app registrada                                 Fase 1

  8        Meta/Facebook (conector)                     Sólo feed de catálogo para ads --- sin venta en Chile   Fase 6 (catálogo de ads)

  9        Clientes                                     Consolidación de pedidos                                Fase 5

  10       Pedidos y ventas de todos los canales        Motor de sincronización entrante                        Fase 3

  11       Carritos abandonados de Shopify              Aprobación de protected customer data                   Fase 4

  12       Recuperación de ventas / correos             Proveedor de email + consentimiento                     Fase 4

  13       Historial / auditoría                        audit_log desde el primer commit                        Fase 1 en adelante (se amplía por fase)

  14       Reportes y exportación Excel                 Datos de ventas/inventario consolidados                 Fase 5

  15       Alertas                                      Motor de sincronización + reglas de negocio             Fase 3 en adelante

  16       Configuración de conexiones y credenciales   Bóveda de credenciales del SO                           Fase 1

  17       Operaciones masivas                          Bulk Operations (Shopify) + colas propias (ML)          Fase 6
  -------------------------------------------------------------------------------------------------------------------------------------------------------

**A. Análisis de viabilidad por plataforma**

**A.1 Shopify --- Viabilidad: alta**

Shopify ofrece una API de administración madura y ampliamente documentada, con dos superficies: la GraphQL Admin API (recomendada, versionada trimestralmente, ej. 2026-01) y la REST Admin API (en deprecación progresiva de recursos en favor de GraphQL). Ambas permiten gestión completa de productos, variantes, inventario multi-ubicación, pedidos, clientes y checkouts abandonados, además de webhooks para eventos casi en tiempo real y una Bulk Operations API para volúmenes grandes sin consumir el presupuesto normal de costo de la API.

-   Autenticación recomendada: una Custom App (app personalizada) instalada directamente en la tienda del usuario desde el Partner Dashboard o el admin de Shopify, con un token de acceso Admin API asociado a los scopes exactos que necesita BLACK SAND (no una app pública de la App Store, que sería para distribuir a terceros).

-   Punto de atención: el acceso a datos de clientes y a checkouts abandonados requiere los scopes de \"protected customer data\" (nivel 1/2). Por defecto una app no tiene este acceso; debe solicitarse y quedar configurada/aprobada por Shopify antes de que la API devuelva datos reales en tiendas de producción. Esto se valida en la Fase 1.

-   Shopify no ofrece envío de correos a compradores de carritos abandonados como función de API --- eso debe resolverlo BLACK SAND con un proveedor de correo propio (ver módulo 12).

**A.2 Mercado Libre (sitio Chile --- MLC) --- Viabilidad: alta**

Mercado Libre expone una API REST pública y estable, con autenticación OAuth2 (Authorization Code + refresh token), que cubre publicaciones (items), categorías, stock, pedidos, preguntas y notificaciones (webhooks) para el sitio MLC. Es, junto con Shopify, la plataforma más automatizable de las tres.

-   Gestión de publicaciones vía POST/PUT sobre el recurso /items, incluyendo variaciones (variations) para talla/color con stock diferenciado por variante --- encaja directamente con el modelo de producto que pide el usuario.

-   El stock se actualiza con el campo available_quantity de cada ítem o variación; este valor sólo es visible/editable con el token del dueño de la publicación (uso normal para BLACK SAND, que administrará su propia cuenta vendedora).

-   Pedidos vía Orders API (consulta por ID y búsqueda /orders/search) y notificaciones push por webhook (tópicos como orders_v2, items, questions) para detectar ventas y cambios sin sondeo constante.

-   Restricción relevante: cada categoría de Mercado Libre impone su propia ficha técnica y validaciones (listing_allowed, atributos obligatorios); no existe un esquema único de producto válido para todas las categorías, algo a modelar en el mapeo de atributos por canal (sección G).

**A.3 Meta / Facebook (Marketplace, Shops, Catálogo) --- Viabilidad: baja para venta transaccional; media para publicidad**

Meta mantiene tres superficies distintas que conviene no confundir: (1) el Catalog API / Commerce Manager, que alimenta anuncios dinámicos y, donde está habilitado, las pestañas de compras de Facebook/Instagram (\"Shops\"); (2) Facebook Marketplace, la superficie de compraventa entre particulares dentro de la app; y (3) las APIs de partner para Marketplace (Marketplace Partner Seller API y Marketplace Approval API), pensadas para agregadores/plataformas grandes que gestionan miles de vendedores, no para que un comercio individual publique sus productos.

**Hallazgo crítico para Chile:** según la documentación de soporte de Meta y guías vigentes para 2026, Facebook e Instagram Shopping (catálogo con etiquetado de productos, pestaña Shop) fueron descontinuados para cuentas de Chile, Argentina y Colombia desde el 10 de agosto de 2023, y en Latinoamérica la función continúa disponible únicamente para México. Esto significa que, hoy, una tienda chilena no puede activar el flujo oficial \"catálogo → Shop/Shopping → Marketplace\" que sí funciona en EE. UU., Canadá, Brasil o México.

-   La Marketplace Partner Seller API exige ser un \"marketplace partner\" aprobado por Meta (alta de vendedores en lote, límite \~200 llamadas/hora, hasta 5.000 vendedores por request) --- perfil de agregador/plataforma, no de un comercio que vende sus propios productos.

-   La Marketplace Approval API permite solicitar y monitorear la aprobación de un catálogo para distribuirse en Marketplace, pero esa aprobación depende de la elegibilidad de país/cuenta descrita arriba: sin Shopping habilitado en Chile, esta vía no aplica en la práctica hoy.

-   No existe una API pública para publicar como si fuera un particular en la app de Marketplace (Meta la excluye deliberadamente por privacidad, prevención de scraping y gestión de riesgo reputacional/legal desde el caso Cambridge Analytica).

-   Lo que sí funciona igual en Chile: el Catalog API para alimentar anuncios dinámicos (Advantage+ catalog ads) y la Conversions API/Pixel para remarketing --- es decir, Meta es viable como canal publicitario basado en el mismo feed de productos, no como canal de venta con stock y pedidos sincronizados.

**Alternativa legítima recomendada:** diseñar el conector de Meta desde el día uno como \"generador de feed de catálogo para publicidad\" (Advantage+ catalog ads / Conversions API), dejando la puerta abierta en el modelo de datos para activar Shops/Marketplace automáticamente si Meta habilita esa función en Chile en el futuro (el mapeo canal→producto ya contempla \"meta\" como canal). Mientras tanto, el tráfico social se resuelve como hoy: enlace en biografía, mensajería (Messenger/Instagram Direct/WhatsApp Business) y anuncios que redirigen a la ficha del producto en Shopify. No se recomienda invertir esfuerzo de desarrollo en sincronización de inventario/pedidos con Meta en las Fases 1--3.

**A.4 Conclusión de viabilidad**

  ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  **Plataforma**        **Viabilidad**                   **Rol en la arquitectura**
  --------------------- -------------------------------- --------------------------------------------------------------------------------------------------------------------------------------------------------
  Shopify               **ALTA**                         Canal principal y editor natural; fuente de verificación cruzada de catálogo/pedidos junto a la app.

  Mercado Libre (MLC)   **ALTA**                         Canal secundario totalmente sincronizable: productos, stock, pedidos y notificaciones.

  Meta / Facebook       **BAJA (venta) / MEDIA (ads)**   Conector opcional de catálogo para publicidad dinámica; sin venta/stock/pedidos sincronizados mientras Chile no tenga Shopping/Marketplace habilitado.
  ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

**B. APIs oficiales a utilizar en cada plataforma**

**B.1 Shopify**

  ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  **Componente**         **Detalle**
  ---------------------- -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  Autenticación          Custom App instalada en la tienda (Admin API access token) mediante OAuth de app personalizada. No se usa la app pública de la App Store.

  API principal          GraphQL Admin API (versión trimestral vigente, ej. 2026-xx). REST Admin API sólo para recursos aún no migrados.

  Productos/variantes    Product, ProductVariant, ProductSet (mutación que crea/actualiza producto + variantes + medios en una sola llamada), Metafields para atributos propios (marca, talla, color, peso, medidas).

  Inventario             InventoryItem, InventoryLevel, Location (multi-bodega). Mutaciones inventoryActivate, inventoryAdjustQuantities, inventoryBulkToggleActivation (idempotentes desde 2026-04).

  Pedidos                Order (lectura), fulfillments, transactions. Webhook orders/create y orders/updated para eventos casi en tiempo real.

  Clientes               Customer --- requiere scopes de \"protected customer data\" aprobados.

  Carritos abandonados   AbandonedCheckout / abandonedCheckouts (GraphQL) --- requiere scope read_orders + manage_abandoned_checkouts + aprobación de protected customer data.

  Webhooks               orders/create, orders/updated, orders/cancelled, inventory_levels/update, products/update, products/create, customers/create, checkouts/update (según disponibilidad). Verificación HMAC obligatoria; sin garantía de orden ni de entrega 100%, requiere job de reconciliación periódica.

  Operaciones masivas    Bulk Operations API (asíncrona, no consume el presupuesto normal de costo, exporta/importa JSONL) para catálogos grandes.

  Límites                GraphQL con presupuesto de costo por consulta (bucket que se recarga a tasa fija según plan); máx. 1.000 puntos por consulta. Requiere cola local con control de throttleStatus.
  ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

**B.2 Mercado Libre (sitio MLC)**

  -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  **Componente**     **Detalle**
  ------------------ ----------------------------------------------------------------------------------------------------------------------------------------------------------------------
  Autenticación      OAuth2 Authorization Code + refresh token, aplicación registrada en developers.mercadolibre.com/devcenter, site_id = MLC.

  Categorías         GET /categories/{id} para validar listing_allowed, status y atributos obligatorios antes de publicar.

  Publicaciones      POST /items (alta), PUT /items/{id} (edición), variations\[\] para talla/color con stock por variante.

  Inventario         Campo available_quantity por ítem o por variación; visible/editable sólo con el token del dueño de la publicación.

  Pedidos            GET /orders/{id}, GET /orders/search (con filtros por estado y fecha).

  Preguntas          Questions API --- no reemplaza el email, pero es el canal de mensajería nativo de la plataforma.

  Notificaciones     Webhooks configurados por callback_url en la app; tópicos relevantes: items, orders_v2, questions, stock-locations, price_suggestion.

  Límites            Rate limiting por aplicación/usuario; sin operación de \"bulk write\" nativa --- la carga masiva se resuelve con colas propias y control de velocidad en BLACK SAND.
  -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

**B.3 Meta / Facebook**

  -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  **Componente**                   **Detalle**
  -------------------------------- --------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  Catalog API                      Graph API sobre /product_catalogs y /products --- gestión de feed de catálogo (para ads dinámicos; para Shopping donde esté habilitado por país).

  Marketing API                    Advantage+ catalog ads (anuncios dinámicos de retargeting/prospecting) a partir del mismo feed.

  Conversions API / Pixel          Tracking de eventos de conversión en el sitio propio para optimizar campañas --- no gestiona inventario ni pedidos.

  Marketplace Partner Seller API   Alta/baja/edición de vendedores en lote --- reservada a partners agregadores aprobados por Meta, no a un comercio individual.

  Marketplace Approval API         Solicita y consulta el estado de aprobación de un catálogo para Marketplace --- depende de elegibilidad de país; Chile no está habilitado hoy para Shopping/Marketplace.

  Órdenes/checkout                 No aplica para Chile: el checkout nativo de Meta no está disponible en el país, por lo que no hay API de pedidos de Meta que sincronizar.
  -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

En síntesis: BLACK SAND debe tratar a Meta como un consumidor de solo-lectura del catálogo central (exporta feed), nunca como un canal que genera pedidos o del que se descuenta stock automáticamente, hasta que Meta habilite Shopping/Marketplace para Chile.

**C. Funciones sincronizables y sus restricciones**

  -----------------------------------------------------------------------------------------------------------------------------------------------------
  **Función**                  **Shopify**                                  **Mercado Libre**                         **Meta / Facebook**
  ---------------------------- -------------------------------------------- ----------------------------------------- ---------------------------------
  Alta/edición de producto     **SÍ**                                       **SÍ**                                    **Sólo feed de catálogo (ads)**

  Variantes talla/color        **SÍ**                                       **SÍ (variations)**                       **N/A**

  Actualizar stock             **SÍ**                                       **SÍ**                                    **N/A**

  Recibir pedidos/ventas       **SÍ (API + webhook)**                       **SÍ (API + webhook)**                    **NO en Chile**

  Clientes / CRM               **SÍ, con aprobación de datos protegidos**   **Datos limitados por pedido**            **N/A**

  Carritos abandonados         **SÍ, con aprobación de datos protegidos**   **No existe el concepto vía API**         **N/A**

  Envío de correo al cliente   **NO nativo (requiere servicio externo)**    **Sólo mensajería interna (preguntas)**   **N/A**

  Webhooks tiempo real         **SÍ**                                       **SÍ**                                    **Limitado a catálogo/ads**

  Publicación/edición masiva   **SÍ (Bulk Operations)**                     **Por lote propio (sin bulk nativo)**     **Feed batch (para ads)**
  -----------------------------------------------------------------------------------------------------------------------------------------------------

Regla de diseño derivada: BLACK SAND nunca debe asumir que \"si funciona en Shopify, funciona igual en los otros dos\". Cada conector declara explícitamente qué operaciones soporta (capacidades por canal, sección D.4) y la interfaz oculta o deshabilita --- nunca simula --- las funciones no disponibles para un canal.

**D. Arquitectura recomendada**

Arquitectura en capas, ejecutada localmente en el PC del usuario, con el patrón: PC → BLACK SAND Manager → Base de datos local (fuente central de verdad) → Motor de sincronización → Conectores → APIs de Shopify / Mercado Libre / Meta.

**D.1 Capas**

**D.2 El problema de los webhooks en un PC de escritorio**

Shopify y Mercado Libre entregan webhooks a una URL HTTPS pública; un PC doméstico normalmente no la tiene (IP dinámica, sin puerto expuesto, apagado fuera de horario). Se recomienda un enfoque híbrido en dos etapas:

1.  MVP (Fase 1--3): sondeo (polling) programado cada 2--5 minutos usando los filtros de \"actualizado desde\" de cada API (updated_at_min en Shopify, date_last_updated en Mercado Libre) --- sin infraestructura adicional, suficiente para un solo local.

2.  Evolución (Fase 4+, opcional): un relay ligero en la nube (función serverless de bajo costo, p. ej. Cloudflare Worker o AWS Lambda) que recibe los webhooks reales de Shopify/Mercado Libre, los deja en una cola liviana, y el PC los retira cuando está en línea --- reduce la latencia de detección de ventas de minutos a segundos sin exponer el PC a internet.

Esta decisión no bloquea la Fase 1: el dashboard de sincronización y la lectura de inventario funcionan por sondeo desde el primer día.

**D.3 Diagrama de componentes**

+-----------------------------------------------------------------------+
| PC del usuario                                                        |
|                                                                       |
| ┌───────────────────────────────────────────────────────────┐         |
|                                                                       |
| │ UI Escritorio (Electron + React) │                                  |
|                                                                       |
| │ │ │                                                                 |
|                                                                       |
| │ Capa de Dominio (reglas de negocio, modelo canónico) │              |
|                                                                       |
| │ │ │                                                                 |
|                                                                       |
| │ Motor de Sincronización (cola + workers + reintentos) │             |
|                                                                       |
| │ │ │ │ │                                                             |
|                                                                       |
| │ ShopifyConnector MLConnector MetaConnector │                        |
|                                                                       |
| │ │ │ │ │                                                             |
|                                                                       |
| │ Base de datos local SQLite ⇄ Bóveda de credenciales │               |
|                                                                       |
| │ Logs de auditoría / cola de sincronización / backups │              |
|                                                                       |
| └──────┬───────────────┬────────────────┬─────────────────────┘       |
|                                                                       |
| │ │ │                                                                 |
|                                                                       |
| Shopify API Mercado Libre API Meta Graph API                          |
|                                                                       |
| (webhook/polling) (webhook/polling) (feed de catálogo)                |
+-----------------------------------------------------------------------+

**D.4 Capacidades declaradas por conector (extracto)**

  -------------------------------------------------------------------------------------------------------
  **Capacidad**              **Shopify**                  **Mercado Libre**
  -------------------------- ---------------------------- -----------------------------------------------
  push_stock                 true                         true

  push_price                 true                         true

  push_product_create        true                         true

  pull_orders                true (API + webhook)         true (API + webhook)

  pull_abandoned_checkouts   true (sujeto a aprobación)   false (no existe en la API)

  pull_customers             true (sujeto a aprobación)   parcial (sólo datos del comprador por pedido)

  bulk_operations            true (Bulk Operations API)   false (se emula con colas propias)
  -------------------------------------------------------------------------------------------------------

Meta se excluye de esta tabla de capacidades transaccionales porque, para Chile, se limita a exportar el feed de catálogo hacia Marketing API/Conversions API (fuera del alcance de inventario/pedidos).

**D.5 Seguridad y credenciales**

-   Tokens y client secrets nunca se guardan en texto plano ni en el repositorio de código: se almacenan en el almacén de credenciales del sistema operativo (Windows Credential Manager / DPAPI vía librerías como keytar o el Credential Locker nativo) y sólo se referencian por identificador desde la base de datos de negocio.

-   Separación de secretos por entorno (desarrollo/producción) y por canal; rotación de tokens antes de expirar (Shopify no expira tokens de custom app salvo revocación; Mercado Libre expira el access_token en horas y requiere refresh_token --- el conector debe automatizar el refresco).

-   Registro de auditoría de quién y cuándo cambió una credencial o disparó una sincronización manual (módulo 13).

-   Backups automáticos y cifrados de la base local (rotación diaria + copia antes de cada operación masiva) para poder revertir un error de carga masiva.

**E. Modelo de datos y base de datos**

Motor recomendado: SQLite (archivo local, sin servidor, ideal para un solo PC/usuario) accedido a través de un ORM que soporte también PostgreSQL (p. ej. Prisma o Drizzle en Node/TypeScript, o SQLAlchemy en Python) para que crecer a un servidor centralizado --- si BLACK SAND abre más locales o necesita acceso remoto --- sea un cambio de configuración, no una reescritura. Excel/CSV se usa exclusivamente como formato de importación/exportación, nunca como almacenamiento primario.

**E.1 Entidades principales**

  --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  **Tabla**                           **Campos clave**
  ----------------------------------- --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  products                            id, sku, barcode, name, description, brand, category, weight, dimensions (largo/ancho/alto), base_cost, base_price, status, created_at, updated_at

  product_variants                    id, product_id, sku_variant, barcode_variant, size, color, cost, price, weight_override, image_id

  product_images                      id, product_id, variant_id (opcional), url/local_path, position

  locations                           id, name, address, is_default (para inventario multi-bodega, alineado con Location de Shopify)

  inventory_items                     id, variant_id, location_id, quantity_on_hand, quantity_committed, quantity_available (calculado), safety_stock

  inventory_movements                 id, inventory_item_id, type (venta_presencial, venta_online, ajuste, ingreso, merma), quantity_delta, reference_type, reference_id, user_id, created_at

  channels                            id, code (shopify \| mercadolibre \| meta), name, is_active, capabilities (JSON con la tabla de D.4)

  channel_credentials                 id, channel_id, credential_ref (puntero a la bóveda del SO), token_expires_at, scopes, status

  channel_product_map                 id, product_id / variant_id, channel_id, channel_product_id, channel_variant_id, channel_sku, last_synced_at, sync_status, last_error

  channel_sync_status                 id (agregado por producto+canal), status (sincronizado/pendiente/error/conflicto), stock_diff, last_synced_at, last_error, retries

  customers                           id, name, rut/documento (opcional), email, phone, address, source_channel, created_at, updated_at, notes

  orders                              id, channel_id (nullable si es venta presencial), channel_order_id (único por canal para evitar duplicados), order_date, customer_id, status, subtotal, discounts, taxes, total, payment_method, sync_status

  order_items                         id, order_id, variant_id, quantity, unit_price, unit_cost, margin

  pos_sales                           id, order_id (venta presencial registrada como orders con channel_id=null), user_id, observations, payment_method

  abandoned_checkouts                 id, channel_id, channel_checkout_id, customer_email, customer_name, line_items (JSON), total, created_at, recovered (bool), email_sent_at

  email_campaigns / recovery_emails   id, abandoned_checkout_id, sent_at, opened_at (si el proveedor lo reporta), status, template_used

  sync_queue                          id, task_type, channel_id, entity_type, entity_id, payload (JSON), status (pending/in_progress/success/error/dead_letter), attempts, next_retry_at, created_at

  sync_log                            id, sync_queue_id, timestamp, level, message, response_snapshot

  audit_log                           id, user_id, action, entity_type, entity_id, before (JSON), after (JSON), created_at

  users                               id, name, email, role (admin/vendedor), password_hash o vínculo a auth local
  --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

**E.2 Campos mínimos por producto (requisito del usuario)**

Cada producto central cumple, como mínimo: SKU, código de barras, nombre, descripción, marca, categoría, costo, precio de venta, peso, dimensiones, imágenes, variantes (talla/color con stock propio), ubicación (bodega) y un estado de publicación independiente por canal (borrador / publicado / pausado / con error), reflejado en channel_sync_status.

**E.3 Ruta de migración a PostgreSQL**

-   Usar un ORM con dialecto intercambiable desde el día uno (evitar SQL específico de SQLite en la capa de dominio).

-   Modelar IDs como UUID/TEXT en vez de autoincrementales dependientes del motor, para portar datos sin colisiones.

-   Encapsular acceso a datos detrás de un repositorio por entidad, de forma que migrar el motor sea cambiar la cadena de conexión y correr las migraciones, no tocar la lógica de negocio.

**F. Flujo de sincronización y resolución de conflictos**

**F.1 Principio de fuente de verdad**

-   Para catálogo y precios/costos/descripciones: BLACK SAND es la fuente de verdad. Todo cambio se hace en la app y se empuja (push) hacia los canales; nunca se edita directo en Shopify o Mercado Libre.

-   Para stock disponible: BLACK SAND es la fuente de verdad consolidada, pero los canales son la fuente del evento de venta --- una venta ocurrida en Shopify o Mercado Libre siempre se refleja primero como inventory_movement en la base local y desde ahí se recalcula el stock consolidado y se propaga al/los otro(s) canal(es).

-   Para pedidos/ventas: cada canal es dueño de sus propios pedidos (no se editan pedidos de Shopify o ML desde BLACK SAND); la app sólo los consolida y registra el movimiento de inventario asociado.

**F.2 Flujo saliente (cambios hechos en BLACK SAND)**

3.  El usuario modifica stock, precio o datos de producto en la UI.

4.  La capa de dominio valida el cambio y lo persiste en la base local (fuente de verdad) de forma inmediata --- la UI nunca espera a la red.

5.  Se encola una SyncTask por cada canal donde el producto está mapeado (channel_product_map).

6.  Un worker por canal toma la tarea, aplica el límite de tasa del conector, ejecuta la llamada a la API, y registra el resultado en channel_sync_status y sync_log.

7.  Si falla, se reintenta con backoff exponencial hasta un máximo de intentos; agotados, la tarea pasa a error/dead-letter y dispara una alerta visible en el dashboard de sincronización.

**F.3 Flujo entrante (ventas ocurridas en un canal)**

8.  El conector detecta una orden nueva (webhook si está disponible, o sondeo programado).

9.  Se verifica idempotencia por channel_order_id: si ya existe en orders, se ignora (evita duplicados en reintentos o reconexiones).

10. Se crea la orden y sus order_items, y por cada línea se genera un inventory_movement que descuenta el stock consolidado.

11. Se encolan SyncTask de tipo push_stock hacia los demás canales donde ese producto está publicado, para reflejar la baja de stock antes de que se venda dos veces.

**F.4 Ventas presenciales**

Registrar una venta presencial crea directamente una orden con channel_id = null (o \"POS\"), genera el/los inventory_movement correspondientes y dispara el mismo flujo saliente de F.2 hacia Shopify y Mercado Libre. Queda registrado: fecha y hora, producto, SKU, variante, cantidad, precio, costo, margen, cliente (si se identifica), medio de pago, observaciones y usuario que la registró --- tal como lo pide el requisito del módulo 3.

**F.5 Resolución de conflictos**

  --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  **Escenario**                                                                            **Resolución**
  ---------------------------------------------------------------------------------------- ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  Venta simultánea en dos canales sobre el último stock disponible (sobreventa)            El primer evento en aplicarse gana y deja el stock en 0; el segundo genera una orden igualmente (no se puede cancelar automáticamente una venta ya pagada), pero se marca con una alerta de discrepancia de stock para gestión manual (contactar al cliente, reponer, etc.). Mitigación preventiva: stock de seguridad configurable por producto (colchón que se resta del disponible publicado).

  Cambio de precio en BLACK SAND mientras hay una tarea pendiente del mismo producto       Se aplica la última intención del usuario (se reemplaza el payload de la tarea pendiente en vez de encolar dos tareas en carrera).

  El canal rechaza el cambio (regla de categoría, campo obligatorio faltante)              La tarea pasa a estado error con el mensaje devuelto por la API; no se reintenta indefinidamente sin intervención --- se muestra en el dashboard con acción \"Reintentar\" tras corregir el dato.

  Edición manual detectada directamente en Shopify o Mercado Libre (fuera de BLACK SAND)   Se detecta por diferencia entre el valor remoto y el last_known_state guardado en channel_product_map; se marca como conflicto y se pide confirmación explícita (nunca se sobrescribe en silencio) sobre cuál valor debe prevalecer.

  Pérdida de conexión del PC durante una sincronización                                    Las tareas quedan en pending/in_progress con timeout; al reconectar, el motor retoma la cola respetando idempotencia.
  --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

**F.6 Idempotencia, reintentos y observabilidad**

-   Toda escritura hacia un canal lleva una clave de idempotencia (aprovechando \@idempotent en mutaciones de Shopify 2026-04+, y control propio de duplicados para Mercado Libre).

-   Reintentos con backoff exponencial y techo (p. ej. 5 intentos, máx. 30 min entre reintentos) antes de pasar a dead-letter.

-   El dashboard de sincronización (módulo 5) muestra, por producto/canal: sincronizado, pendiente, error, diferencia de stock, última sincronización, último error y una acción de reintentar --- exactamente el set de columnas solicitado.

-   Todo el detalle queda en sync_log para auditoría y depuración; los webhooks recibidos también se registran (payload + firma verificada) antes de procesarse.

**G. Sistema de mapeo de productos y variantes entre canales**

channel_product_map es la pieza que conecta el producto/variante central con el identificador real de cada canal (product_id + variant_id de Shopify; item_id + variation_id de Mercado Libre), de modo que cada actualización se aplique sobre la publicación correcta y nunca sobre otra por error.

**G.1 Estrategias de emparejamiento inicial**

12. Importación inicial: al conectar cada canal, BLACK SAND lee su catálogo existente y intenta emparejar automáticamente por SKU o código de barras exacto contra el catálogo central (o crea productos nuevos si no existen aún).

13. Casos ambiguos (mismo nombre, SKU distinto o ausente): se listan en una pantalla de conciliación manual donde el usuario confirma el emparejamiento antes de que quede activo --- nunca se fusiona automáticamente sin confirmación.

14. Productos nuevos creados en BLACK SAND: se publican por primera vez en el canal (alta) y el ID que devuelve la API se guarda de inmediato en channel_product_map.

**G.2 Reglas de integridad**

-   Un product_variant central puede mapear a lo sumo un item/variación por canal (relación 1 a 1 por canal); si el usuario necesita desvincular, la app pide confirmación explícita porque implica dejar de sincronizar esa publicación.

-   BLACK SAND nunca sobreescribe campos específicos de un canal que no le pertenecen (por ejemplo, la categoría y ficha técnica de Mercado Libre, o el estado SEO de Shopify): sólo actualiza los campos que administra explícitamente (precio, stock, descripción, imágenes, atributos mapeados) y deja el resto intacto --- cumpliendo el requisito de no destruir información propia de cada plataforma.

-   Cada canal define su propio diccionario de atributos (p. ej. \"Talla\" en Shopify como opción de variante vs. atributo de ficha técnica en Mercado Libre); el mapeo de atributos por categoría se versiona y es editable, no hardcodeado.

**H. Plan por fases / MVP**

El plan avanza de menor a mayor riesgo: primero se valida que la conexión y la lectura funcionen de punta a punta (Fase 1, detallada en la sección L), y sólo después se habilita escritura, ventas y funciones dependientes de aprobaciones (datos protegidos, carritos abandonados).

  ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  **Fase**               **Nombre**                                       **Alcance**
  ---------------------- ------------------------------------------------ ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  0                      Descubrimiento y accesos                         Crear la Custom App de Shopify y la app de Mercado Libre, definir scopes, decidir el rol de Meta (sólo catálogo de ads), y levantar el esqueleto del proyecto (sección K).

  1                      Cimiento (detallada en sección L)                Conexión segura a los tres canales, lectura de productos/inventario, base local, mapeo de IDs, dashboard de sincronización de solo lectura. Sin escritura todavía.

  2                      Escritura de catálogo e inventario               Edición individual y masiva de producto/variante/stock/precio en BLACK SAND con push a Shopify y Mercado Libre; alta de productos nuevos en ambos canales.

  3                      Ventas presenciales y consolidación de pedidos   Módulo de venta en mostrador con descuento de stock y registro completo; ingesta de pedidos online de Shopify y Mercado Libre con motor de conflictos, cola de reintentos y alertas de discrepancia (módulos 3, 10, 5).

  4                      Carritos abandonados y recuperación              Lectura de AbandonedCheckout de Shopify (sujeta a aprobación de protected customer data), pantalla de seguimiento y envío de correos de recuperación vía proveedor externo, con registro de consentimiento (módulos 11--12).

  5                      Clientes, reportes y auditoría                   Ficha de cliente que se actualiza con cada venta, exportación a Excel de ventas/inventario, historial de auditoría completo (módulos 9, 13, 14).

  6                      Operaciones masivas avanzadas y Meta             Publicación/edición masiva multicanal con vista previa antes de aplicar, generación y mantenimiento del feed de catálogo para Meta Ads, alertas configurables (módulos 15, 17).

  7 (futuro, opcional)   Escalamiento                                     Evaluar migración de SQLite a PostgreSQL si aparecen múltiples locales, usuarios concurrentes o acceso remoto; reevaluar Meta Shopping/Marketplace por si Meta habilita Chile.
  ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

**I. Riesgos y limitaciones**

  --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  **Riesgo**                                                                                                                **Mitigación**
  ------------------------------------------------------------------------------------------------------------------------- ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  Meta no permite Shopping/Marketplace en Chile hoy                                                                         Conector diseñado como opcional y desacoplado (sólo feed de ads); revalidar elegibilidad de país periódicamente sin rediseñar la arquitectura.

  Sobreventa por ventana de sincronización entre canales                                                                    Stock de seguridad configurable, sondeo frecuente en Fase 1--3, y migración a webhooks/relay en cuanto el volumen lo justifique; alertas inmediatas de discrepancia.

  Aprobación de \"protected customer data\" de Shopify puede demorar o ser rechazada                                        Solicitarla al inicio de la Fase 1 como tarea independiente, con plan B: continuar sin carritos abandonados/CRM completo hasta obtenerla, sin bloquear el resto del roadmap.

  Un PC doméstico no puede recibir webhooks de forma confiable                                                              Arquitectura híbrida de sondeo + relay opcional en la nube (sección D.2), pensada desde el diseño, no como parche posterior.

  Rate limits de Shopify y Mercado Libre                                                                                    Cola local con control de throttleStatus (Shopify) y límites por app (ML); uso de Bulk Operations para cargas grandes en Shopify.

  Cambios de versión/política de API (Shopify vence versiones \~1 año; Meta y ML pueden ajustar reglas sin aviso extenso)   Aislar cada canal en su propio conector versionado; monitoreo de changelog oficial como tarea recurrente; pruebas de humo antes de subir de versión.

  Exposición de credenciales                                                                                                Bóveda del sistema operativo, nunca archivos planos ni variables de entorno versionadas; rotación y auditoría de acceso (sección D.5).

  Errores humanos en operaciones masivas                                                                                    Vista previa obligatoria (dry-run) antes de aplicar cambios masivos, backup automático previo y posibilidad de revertir vía audit_log.

  Dependencia de la conectividad del PC del usuario                                                                         Cola persistente en disco: los cambios se guardan localmente y se sincronizan apenas vuelve la conexión, sin perder información.

  Datos personales de clientes y carritos abandonados (Ley 19.628 / futura ley de protección de datos en Chile)             Registrar consentimiento antes de enviar correos de recuperación, minimizar los datos almacenados a lo necesario, y permitir eliminación de datos de un cliente a pedido.
  --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

**J. Recomendaciones de tecnología para la interfaz de escritorio**

**J.1 Stack recomendado**

  ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  **Componente**            **Recomendación**
  ------------------------- ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  Framework de escritorio   Electron + React + TypeScript --- ecosistema más maduro para UI compleja tipo panel de administración, mejor disponibilidad de librerías de integración (OAuth, colas, drivers SQLite) y empaquetado/actualización automática vía electron-builder + electron-updater. Alternativa más liviana: Tauri (Rust) + React si se prioriza tamaño de instalador y consumo de RAM sobre velocidad de desarrollo.

  Lenguaje                  TypeScript en toda la capa de aplicación (tipado fuerte para los modelos de producto/inventario y los DTOs de cada API).

  Base de datos             SQLite vía better-sqlite3 o driver equivalente, con ORM Prisma o Drizzle (ambos migran a PostgreSQL cambiando el provider).

  Cola de tareas            Tabla sync_queue propia + un scheduler ligero (node-cron / setInterval controlado) es suficiente para un solo PC; evita depender de Redis/infra externa en el MVP.

  UI Kit                    Mantine o shadcn/ui sobre Tailwind CSS --- componentes de tabla, formularios y dashboards ya resueltos, coherentes con un panel de datos denso.

  Gráficos/reportes         Recharts o Chart.js para el dashboard; ExcelJS para exportar reportes a .xlsx respetando formato y fórmulas.

  Gestión de credenciales   keytar (o equivalente) para integrarse con Windows Credential Manager.

  Validación de datos       Zod para validar formularios y payloads antes de tocar la base o las APIs externas.

  Empaquetado               electron-builder con firma de código y actualizaciones automáticas, orientado a Windows (entorno detectado del usuario), con opción a macOS/Linux si se necesita más adelante.
  ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

**J.2 Por qué no Access/Excel ni sólo un script**

El propio pedido original (CSV de Shopify \"complicado\") ya evidencia el límite de hojas de cálculo para esta operación: no hay forma de encolar reintentos, mostrar estado en vivo por producto/canal, ni guardar auditoría de forma confiable en un archivo Excel. Excel/CSV se conserva sólo como puerta de entrada/salida masiva (importar catálogo inicial, exportar reportes), nunca como el sistema en sí.

**K. Estructura inicial del proyecto**

+-----------------------------------------------------------------------+
| blacksand-manager/                                                    |
|                                                                       |
| ├── apps/                                                             |
|                                                                       |
| │ └── desktop/ \# Electron + React (UI)                               |
|                                                                       |
| │ ├── src/                                                            |
|                                                                       |
| │ │ ├── renderer/ \# pantallas (ver K.1)                              |
|                                                                       |
| │ │ ├── main/ \# proceso principal Electron, IPC                      |
|                                                                       |
| │ │ └── preload/                                                      |
|                                                                       |
| │ └── package.json                                                    |
|                                                                       |
| ├── packages/                                                         |
|                                                                       |
| │ ├── core-domain/ \# modelo canónico, reglas de negocio              |
|                                                                       |
| │ ├── db/ \# esquema ORM, migraciones, repos                          |
|                                                                       |
| │ ├── sync-engine/ \# cola, workers, reintentos                       |
|                                                                       |
| │ ├── connectors/                                                     |
|                                                                       |
| │ │ ├── shopify/ \# cliente GraphQL, webhooks                         |
|                                                                       |
| │ │ ├── mercadolibre/ \# cliente REST, OAuth2                         |
|                                                                       |
| │ │ └── meta/ \# feed de catálogo (solo export)                       |
|                                                                       |
| │ ├── email/ \# recuperación de carritos                              |
|                                                                       |
| │ └── shared/ \# tipos y validaciones                                 |
|                                                                       |
| ├── scripts/ \# import CSV, backups, migraciones                      |
|                                                                       |
| ├── docs/ \# este documento y decisiones (ADR)                        |
|                                                                       |
| └── .env.example \# solo nombres de variables                         |
+-----------------------------------------------------------------------+

**K.1 Pantallas del módulo renderer**

dashboard, inventario, productos, ventas-pos, sincronizacion, clientes, pedidos, carritos-abandonados, reportes y configuracion --- una carpeta por pantalla, cada una consumiendo sólo la capa de dominio (nunca los conectores directamente).

Separar core-domain de connectors desde el inicio es lo que permite cumplir el requisito de \"no depender exclusivamente de CSV\" y agregar o retirar un canal (por ejemplo, activar Meta Shopping si Meta lo habilita en Chile) sin tocar la lógica de negocio ni la base de datos.

**L. Propuesta de Fase 1 (punto de partida concreto)**

Objetivo único de esta fase: demostrar que BLACK SAND puede conectarse de forma segura a Shopify, Mercado Libre y (como feed de catálogo) Meta, traer su catálogo/inventario real a la base local, mapear correctamente cada producto/variante con su canal, y mostrar el estado de esa sincronización en un dashboard --- sin escribir todavía nada de vuelta a los canales. No se avanza a ventas, carritos abandonados ni operaciones masivas hasta validar esto con datos reales de la tienda.

**L.1 Entregables**

15. Custom App de Shopify creada e instalada en la tienda, con los scopes mínimos read_products, read_inventory, read_orders (y solicitud iniciada de protected customer data para preparar fases futuras).

16. Aplicación registrada en Mercado Libre (site MLC) con OAuth2 funcionando de punta a punta (autorización, access_token, refresco automático de refresh_token).

17. Credenciales de ambos canales guardadas en la bóveda del sistema operativo, nunca en archivo plano.

18. Generador de feed de catálogo básico para Meta (sin publicar aún; sólo preparado para Advantage+ catalog ads más adelante).

19. Base de datos local (SQLite) con el esquema mínimo de E.1: products, product_variants, inventory_items, locations, channels, channel_product_map, channel_sync_status.

20. Importador que lee el catálogo completo de Shopify y de Mercado Libre y llena la base local, emparejando por SKU/código de barras y dejando en conciliación manual los casos ambiguos (G.1).

21. Dashboard de sincronización (solo lectura en esta fase) con las columnas: sincronizado / pendiente / error / diferencia de stock / última sincronización / último error, alimentado por un job de sondeo periódico (sin push todavía).

22. Registro básico de auditoría de las operaciones de esta fase (conexión, importación, conciliación manual).

**L.2 Criterios de aceptación**

-   El 100% de los productos activos de Shopify y de Mercado Libre aparece en la base local, cada uno con su channel_product_map correcto (o marcado explícitamente como pendiente de conciliación).

-   El dashboard refleja, sin intervención manual, cualquier cambio de stock hecho directamente en Shopify o Mercado Libre dentro de la ventana de sondeo configurada (objetivo inicial: 5 minutos).

-   Ninguna credencial aparece en archivos de código, logs o base de datos en texto plano.

-   El sistema soporta reconectar tras perder internet sin duplicar datos ni perder el progreso de la importación.

**L.3 Fuera de alcance en esta fase (a propósito)**

-   Cualquier escritura hacia Shopify, Mercado Libre o Meta (eso es Fase 2).

-   Ventas presenciales y consolidación de pedidos online (Fase 3).

-   Carritos abandonados y correos de recuperación (Fase 4).

-   Publicación en Meta Shopping/Marketplace (no disponible para Chile; ver A.3).

**Fuentes consultadas**

Documentación oficial y de soporte revisada para este análisis (septiembre de 2026):

-   [Shopify --- InventoryLevel (GraphQL Admin)](https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryLevel)

-   [Shopify --- AbandonedCheckout (GraphQL Admin)](https://shopify.dev/docs/api/admin-graphql/latest/objects/AbandonedCheckout)

-   [Shopify --- API access scopes / protected customer data](https://shopify.dev/docs/api/usage/access-scopes)

-   [Shopify --- About webhooks](https://shopify.dev/docs/apps/build/webhooks)

-   [Shopify --- GraphQL Admin API reference](https://shopify.dev/docs/api/admin-graphql/latest)

-   [Mercado Libre --- Items & Searches](https://developers.mercadolibre.com.ar/en_us/items-and-searches)

-   [Mercado Libre --- List products (alta/edición de items)](https://developers.mercadolibre.com.ar/en_us/list-products)

-   [Mercado Libre --- Manage sales (orders API)](https://developers.mercadolibre.com.ar/en_us/manage-sales)

-   [Meta for Developers --- Marketplace Partner Seller API](https://developers.facebook.com/docs/marketplace/partnerships/sellerAPI/)

-   [Meta for Developers --- Marketplace Approval API](https://developers.facebook.com/documentation/ads-commerce/commerce-platform/platforms/distribution/MPApprovalAPI)

-   [Meta for Developers --- Commerce Platform (overview)](https://developers.facebook.com/docs/commerce-platform)

-   [Tiendanube --- Requisitos para vender en Facebook e Instagram Shopping (Chile no habilitado desde ago. 2023)](https://ayuda.tiendanube.com/es_ES/requisitos-para-facebook-e-instagram/requisitos-para-vender-en-facebook-e-instagram-shopping)

-   [Forrate.cl --- Instagram Shopping en Chile 2026: ¿se puede activar?](https://forrate.cl/blog/como-activar-instagram-shopping)

*Nota: algunas páginas de blogs de terceros (AdsX, No7 Software, api2cart, SociaVault, entre otras) se usaron sólo como referencia complementaria de contexto de mercado 2026; toda afirmación normativa sobre qué permite o no cada API se contrastó contra la documentación oficial listada arriba.*
