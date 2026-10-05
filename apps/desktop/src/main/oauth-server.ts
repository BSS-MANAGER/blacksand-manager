// Este archivo quedó sin uso: originalmente levantaba un servidor local
// (primero HTTP, después HTTPS con certificado autofirmado) para capturar
// automáticamente el callback de OAuth2 de Mercado Libre.
//
// Mercado Libre valida el "Redirect URI" registrado y rechaza cualquier
// dirección que no sea un dominio público real (tanto "http://localhost..."
// como "https://localhost..." dan error — "La dirección debe ser válida").
// No hay forma de exponer un servidor local sin un dominio/túnel propio, así
// que el flujo de conexión ahora usa una página pública real como
// redirect_uri y el usuario pega de vuelta el código de esa URL — ver
// `parseMeliOAuthPaste` y el handler `channels:completeMercadoLibreOAuth`
// en `apps/desktop/src/main/ipc.ts`.
//
// Se deja este archivo (sin exportar nada usado) en vez de borrarlo para no
// perder el historial de por qué se intentó este camino primero.
export {};
