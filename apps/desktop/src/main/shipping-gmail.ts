import { ipcMain, shell } from "electron";
import { createServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import {
  getShippingSetting,
  setShippingSetting,
  insertShippingEvents,
  listKnownShippingMessageIds,
  listShippingEventsByMonth,
  listShippingOverridesByMonth,
  setShippingDayOverride,
  type ShippingEmailEventRow,
} from "@blacksand/db";
import { buildShippingMonthSummary, parseShippingEmail } from "@blacksand/sync-engine";
import { getCredentialVault, newCredentialRef } from "@blacksand/credentials";
import { readAppConfig, updateAppConfig } from "./config-store.js";
import { IPC_CHANNELS } from "../shared-ipc-types.js";
import type {
  ShippingGmailStatus,
  ShippingMonthSummaryDto,
  ShippingSyncResult,
} from "../shared-ipc-types.js";

/**
 * Registro de días de despacho a partir de Gmail (solo lectura).
 *
 * - Autorización: OAuth de Google para "app de escritorio" con redirección a
 *   127.0.0.1 (loopback) + PKCE. Permiso pedido: `gmail.readonly` (no puede
 *   enviar, borrar ni modificar correos).
 * - El Client ID es de la propia cuenta Google Cloud del usuario; el Client
 *   Secret y el refresh token van a la bóveda del sistema, nunca al disco en claro.
 */

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const SCOPES = "https://www.googleapis.com/auth/gmail.readonly";
const DEFAULT_DAILY_RATE = 3000;
const FIRST_SYNC_DAYS = 120;
const OVERLAP_DAYS = 5;

let activeServer: Server | null = null;
let cachedAccess: { token: string; expiresAt: number } | null = null;

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

async function getDailyRate(): Promise<number> {
  const raw = await getShippingSetting("dailyRate");
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_RATE;
}

async function getStatus(): Promise<ShippingGmailStatus> {
  const cfg = readAppConfig().gmail;
  return {
    clientConfigured: Boolean(cfg?.clientId && cfg?.clientSecretRef),
    clientId: cfg?.clientId ?? null,
    connected: Boolean(cfg?.refreshTokenRef),
    email: cfg?.email ?? null,
    lastSyncAt: cfg?.lastSyncAt ?? null,
    dailyRate: await getDailyRate(),
  };
}

// --- OAuth ------------------------------------------------------------------

async function tokenRequest(params: Record<string, string>): Promise<{
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = String(json.error ?? res.status);
    const desc = String(json.error_description ?? "");
    if (code === "invalid_grant") {
      throw new Error(
        "Google rechazó la autorización guardada (venció o fue revocada). Vuelve a presionar \"Conectar Gmail\". " +
          "Si te pasa cada ~7 días, la pantalla de consentimiento de Google Cloud sigue en modo \"Pruebas\": publícala (Público → Publicar app).",
      );
    }
    throw new Error(`Google respondió con error (${code}${desc ? `: ${desc}` : ""}).`);
  }
  return json as { access_token: string; expires_in: number; refresh_token?: string };
}

async function readClientCredentials(): Promise<{ clientId: string; clientSecret: string }> {
  const cfg = readAppConfig().gmail;
  if (!cfg?.clientId || !cfg.clientSecretRef) {
    throw new Error("Primero pega el ID de cliente y el secreto de Google en la pantalla de Despachos.");
  }
  const secret = await getCredentialVault().get(cfg.clientSecretRef);
  if (!secret) throw new Error("No se encontró el secreto de Google guardado. Vuelve a guardarlo.");
  return { clientId: cfg.clientId, clientSecret: secret };
}

async function getAccessToken(): Promise<string> {
  if (cachedAccess && cachedAccess.expiresAt > Date.now() + 60_000) return cachedAccess.token;
  const cfg = readAppConfig().gmail;
  if (!cfg?.refreshTokenRef) throw new Error("Gmail no está conectado. Presiona \"Conectar Gmail\".");
  const refresh = await getCredentialVault().get(cfg.refreshTokenRef);
  if (!refresh) throw new Error("Gmail no está conectado. Presiona \"Conectar Gmail\".");
  const { clientId, clientSecret } = await readClientCredentials();
  const t = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refresh,
    client_id: clientId,
    client_secret: clientSecret,
  });
  cachedAccess = { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
  return t.access_token;
}

async function gmailGet<T>(path: string): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${GMAIL_API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) cachedAccess = null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 403 && /accessNotConfigured|has not been used|disabled/i.test(text)) {
      throw new Error("La API de Gmail no está habilitada en tu proyecto de Google Cloud (Biblioteca → Gmail API → Habilitar).");
    }
    throw new Error(`Gmail respondió ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

function closeActiveServer(): void {
  if (activeServer) {
    try {
      activeServer.close();
    } catch {
      /* ya cerrado */
    }
    activeServer = null;
  }
}

async function connectGmail(): Promise<ShippingGmailStatus> {
  const { clientId, clientSecret } = await readClientCredentials();
  closeActiveServer();

  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    let listenPort = 0;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/") {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const gotCode = url.searchParams.get("code");
      const gotState = url.searchParams.get("state");
      const page = (title: string, msg: string) =>
        `<!doctype html><html lang="es"><meta charset="utf-8"><title>BLACK SAND Manager</title>` +
        `<body style="font-family:system-ui,sans-serif;max-width:480px;margin:15vh auto;text-align:center">` +
        `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(msg)}</p></body></html>`;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      if (error || !gotCode || gotState !== state) {
        res.writeHead(400).end(page("No se pudo conectar", "Puedes cerrar esta pestaña y volver a intentarlo desde la app."));
        clearTimeout(timer);
        server.close();
        activeServer = null;
        reject(new Error(error ? `Google devolvió: ${error}` : "Respuesta de autorización inválida."));
        return;
      }
      res.writeHead(200).end(page("¡Gmail conectado!", "Ya puedes cerrar esta pestaña y volver a BLACK SAND Manager."));
      clearTimeout(timer);
      // El puerto se leyó al abrir el servidor (después de `close()` ya no se puede consultar).
      resolve({ code: gotCode, redirectUri: `http://127.0.0.1:${listenPort}` });
      server.close();
      activeServer = null;
    });
    const timer = setTimeout(() => {
      server.close();
      activeServer = null;
      reject(new Error("Se agotó el tiempo (3 minutos) esperando la autorización de Google."));
    }, 180_000);
    server.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    server.listen(0, "127.0.0.1", () => {
      activeServer = server;
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      listenPort = port;
      const authUrl =
        `${GOOGLE_AUTH_URL}?` +
        new URLSearchParams({
          client_id: clientId,
          redirect_uri: `http://127.0.0.1:${port}`,
          response_type: "code",
          scope: SCOPES,
          access_type: "offline",
          prompt: "consent",
          code_challenge: challenge,
          code_challenge_method: "S256",
          state,
          login_hint: "arenanegraseguridad@gmail.com",
        }).toString();
      void shell.openExternal(authUrl);
    });
  });

  const t = await tokenRequest({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  if (!t.refresh_token) {
    throw new Error("Google no entregó permiso de acceso permanente. Vuelve a intentar y acepta todos los permisos.");
  }

  const vault = getCredentialVault();
  const prev = readAppConfig().gmail;
  if (prev?.refreshTokenRef) await vault.delete(prev.refreshTokenRef).catch(() => false);
  const refreshRef = newCredentialRef("gmail", "refresh_token");
  await vault.set(refreshRef, t.refresh_token);
  cachedAccess = { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };

  let email: string | undefined;
  try {
    const profile = await gmailGet<{ emailAddress?: string }>("/profile");
    email = profile.emailAddress;
  } catch {
    /* el correo es solo informativo */
  }

  const current = readAppConfig().gmail;
  updateAppConfig({
    gmail: { ...current!, clientId, clientSecretRef: current!.clientSecretRef, refreshTokenRef: refreshRef, email },
  });
  return getStatus();
}

// --- Lectura de correos -----------------------------------------------------

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}
interface GmailMessage {
  id: string;
  internalDate?: string;
  payload?: GmailPart & { headers?: { name: string; value: string }[] };
}

function decodeMimeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, _charset, enc, text) => {
    try {
      if (String(enc).toUpperCase() === "B") return Buffer.from(text, "base64").toString("utf-8");
      const bytes = String(text)
        .replace(/_/g, " ")
        .replace(/=([0-9A-Fa-f]{2})/g, (_x, h) => String.fromCharCode(parseInt(h, 16)));
      return Buffer.from(bytes, "latin1").toString("utf-8");
    } catch {
      return text;
    }
  });
}

function decodeBody(data?: string): string {
  if (!data) return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

function collectText(part: GmailPart | undefined, out: { plain: string[]; html: string[] }): void {
  if (!part) return;
  if (part.mimeType === "text/plain") out.plain.push(decodeBody(part.body?.data));
  else if (part.mimeType === "text/html") out.html.push(decodeBody(part.body?.data));
  for (const p of part.parts ?? []) collectText(p, out);
}

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&aacute;/g, "á").replace(/&eacute;/g, "é").replace(/&iacute;/g, "í").replace(/&oacute;/g, "ó").replace(/&uacute;/g, "ú").replace(/&ntilde;/g, "ñ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ");
}

// `in:anywhere` incluye también Papelera y Spam: un correo borrado hace poco igual se puede leer.
const SEARCH_QUERY =
  'in:anywhere (from:notificaciones@bx.cl OR from:no-reply@mercadolibre.cl OR from:mercadolibre.cl) ' +
  '(subject:"Admisión PickUp" OR subject:"Comprobante de despacho")';

async function syncFromGmail(): Promise<ShippingSyncResult> {
  const cfg = readAppConfig().gmail;
  const sinceMs = cfg?.lastSyncAt
    ? new Date(cfg.lastSyncAt).getTime() - OVERLAP_DAYS * 86_400_000
    : Date.now() - FIRST_SYNC_DAYS * 86_400_000;
  const startedAt = new Date().toISOString();
  const after = Math.floor(sinceMs / 1000);

  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({ q: `${SEARCH_QUERY} after:${after}`, maxResults: "100" });
    if (pageToken) q.set("pageToken", pageToken);
    const page = await gmailGet<{ messages?: { id: string }[]; nextPageToken?: string }>(`/messages?${q.toString()}`);
    for (const m of page.messages ?? []) ids.push(m.id);
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < 1000);

  const known = await listKnownShippingMessageIds(ids);
  // Se descargan los correos nuevos y los ya guardados a los que aún les faltan los números de orden/venta.
  const fresh = ids.filter((id) => known.get(id) !== true);

  const events: ShippingEmailEventRow[] = [];
  let ignored = 0;
  for (const id of fresh) {
    const msg = await gmailGet<GmailMessage>(`/messages/${id}?format=full`);
    const headers = msg.payload?.headers ?? [];
    const h = (n: string) => decodeMimeWords(headers.find((x) => x.name.toLowerCase() === n)?.value ?? "");
    const texts = { plain: [] as string[], html: [] as string[] };
    collectText(msg.payload, texts);
    const body = texts.plain.join("\n") || htmlToText(texts.html.join("\n"));
    const receivedAt = new Date(Number(msg.internalDate ?? Date.now()));
    const parsed = parseShippingEmail({ from: h("from"), subject: h("subject"), body, receivedAt });
    if (!parsed) {
      ignored += 1;
      continue;
    }
    events.push({
      gmailMessageId: id,
      carrier: parsed.carrier,
      dispatchDay: parsed.dispatchDay,
      packages: parsed.packages,
      subject: h("subject"),
      receivedAt,
      orderRefs: parsed.refs,
    });
  }

  await insertShippingEvents(events);
  const inserted = events.filter((e) => !known.has(e.gmailMessageId)).length;
  const current = readAppConfig().gmail;
  if (current) updateAppConfig({ gmail: { ...current, lastSyncAt: startedAt } });
  return { found: ids.length, newEmails: fresh.filter((id) => !known.has(id)).length, newEvents: inserted, ignored, syncedAt: startedAt };
}

// --- IPC --------------------------------------------------------------------

export function registerShippingHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.shippingGetStatus, (): Promise<ShippingGmailStatus> => getStatus());

  ipcMain.handle(
    IPC_CHANNELS.shippingSaveGoogleClient,
    async (_e, input: { clientId: string; clientSecret: string }): Promise<ShippingGmailStatus> => {
      const clientId = input.clientId.trim();
      const clientSecret = input.clientSecret.trim();
      if (!clientId || !clientSecret) throw new Error("Falta el ID de cliente o el secreto de cliente.");
      const vault = getCredentialVault();
      const prev = readAppConfig().gmail;
      if (prev?.clientSecretRef) await vault.delete(prev.clientSecretRef).catch(() => false);
      const ref = newCredentialRef("gmail", "client_secret");
      await vault.set(ref, clientSecret);
      cachedAccess = null;
      updateAppConfig({ gmail: { ...prev, clientId, clientSecretRef: ref } });
      return getStatus();
    },
  );

  ipcMain.handle(IPC_CHANNELS.shippingConnectGmail, (): Promise<ShippingGmailStatus> => connectGmail());

  ipcMain.handle(IPC_CHANNELS.shippingDisconnectGmail, async (): Promise<ShippingGmailStatus> => {
    const prev = readAppConfig().gmail;
    if (prev?.refreshTokenRef) await getCredentialVault().delete(prev.refreshTokenRef).catch(() => false);
    cachedAccess = null;
    if (prev) updateAppConfig({ gmail: { ...prev, refreshTokenRef: undefined, email: undefined } });
    return getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.shippingSync, (): Promise<ShippingSyncResult> => syncFromGmail());

  ipcMain.handle(
    IPC_CHANNELS.shippingGetMonth,
    async (_e, year: number, month: number): Promise<ShippingMonthSummaryDto> => {
      const prefix = `${year}-${String(month).padStart(2, "0")}`;
      const [events, overrides, dailyRate] = await Promise.all([
        listShippingEventsByMonth(prefix),
        listShippingOverridesByMonth(prefix),
        getDailyRate(),
      ]);
      return buildShippingMonthSummary({
        year,
        month,
        dailyRate,
        events: events.map((e) => ({ carrier: e.carrier, dispatchDay: e.dispatchDay, packages: e.packages, refs: e.orderRefs })),
        overrides,
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.shippingSetDayOverride,
    async (_e, day: string, dispatched: boolean | null, note?: string | null): Promise<{ ok: true }> => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Fecha inválida.");
      await setShippingDayOverride(day, dispatched, note);
      return { ok: true };
    },
  );

  ipcMain.handle(IPC_CHANNELS.shippingSetDailyRate, async (_e, rate: number): Promise<{ ok: true }> => {
    if (!Number.isFinite(rate) || rate < 0) throw new Error("Monto inválido.");
    await setShippingSetting("dailyRate", String(Math.round(rate)));
    return { ok: true };
  });
}
