import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";

/**
 * Bóveda de credenciales (sección D.5): los tokens y client secrets NUNCA se
 * guardan en texto plano ni en el repositorio de código. La base de negocio
 * solo guarda un `credentialRef` (ver ChannelCredential.credentialRef) que
 * apunta a un secreto guardado aquí.
 *
 * Modo "os" (recomendado / producción en Windows): usa keytar, que en Windows
 * escribe en el Windows Credential Manager (DPAPI). Requiere que el módulo
 * nativo `keytar` esté compilado para la plataforma de destino (se instala
 * automáticamente vía electron-builder/npm en el PC del usuario).
 *
 * Modo "dev-file-insecure": SOLO para desarrollo en máquinas donde keytar no
 * está disponible (p. ej. este entorno de generación de código, contenedores
 * Linux sin backend de credenciales). Nunca usar en producción. Aun así, el
 * archivo se cifra con AES-256-GCM derivada de una clave de máquina — no es
 * "texto plano", pero tampoco reemplaza a la bóveda del SO.
 */
export type VaultMode = "os" | "dev-file-insecure";

const SERVICE_NAME = "BLACK SAND Manager";

export interface CredentialVault {
  set(ref: string, secret: string): Promise<void>;
  get(ref: string): Promise<string | null>;
  delete(ref: string): Promise<boolean>;
}

function resolveMode(): VaultMode {
  const configured = process.env.CREDENTIAL_VAULT_MODE as VaultMode | undefined;
  return configured === "dev-file-insecure" ? "dev-file-insecure" : "os";
}

class OsKeytarVault implements CredentialVault {
  async set(ref: string, secret: string): Promise<void> {
    const keytar = await loadKeytar();
    await keytar.setPassword(SERVICE_NAME, ref, secret);
  }
  async get(ref: string): Promise<string | null> {
    const keytar = await loadKeytar();
    return keytar.getPassword(SERVICE_NAME, ref);
  }
  async delete(ref: string): Promise<boolean> {
    const keytar = await loadKeytar();
    return keytar.deletePassword(SERVICE_NAME, ref);
  }
}

interface KeytarModule {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

let cachedKeytar: KeytarModule | undefined;

async function loadKeytar(): Promise<KeytarModule> {
  if (cachedKeytar) return cachedKeytar;
  try {
    // keytar es un módulo nativo CommonJS. Antes se cargaba con
    // `await import("keytar")`, pero este paquete se empaqueta con
    // Vite/Rollup dentro del proceso main de Electron (salida CJS — ver
    // electron.vite.config.ts): ahí, un import() dinámico de una
    // dependencia externa pasa por la capa de interop ESM↔CJS de Rollup,
    // que puede envolver mal `module.exports` de un addon nativo (síntoma
    // real visto: "keytar.setPassword is not a function"). El `require`
    // nativo disponible en el bundle CJS evita esa capa por completo y
    // entrega el objeto de keytar tal cual lo expone el addon.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("keytar") as KeytarModule;
    cachedKeytar = mod;
    return mod;
  } catch (err) {
    throw new Error(
      "No se pudo cargar keytar (bóveda del SO). En Windows, corre `pnpm install` en el " +
        "paquete apps/desktop para compilar el módulo nativo, o usa CREDENTIAL_VAULT_MODE=" +
        "dev-file-insecure solo para desarrollo. Detalle: " + String(err),
    );
  }
}

/** Deriva una clave de 32 bytes específica de esta máquina/usuario (no es un secreto compartido). */
function machineKey(): Buffer {
  const material = `${hostname()}:${userInfo().username}:blacksand-dev-vault`;
  return scryptSync(material, "blacksand-manager-salt", 32);
}

class DevFileVault implements CredentialVault {
  private filePath: string;

  constructor() {
    const dir = join(homedir(), ".blacksand-manager");
    mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, "dev-vault.enc.json");
  }

  private readAll(): Record<string, string> {
    if (!existsSync(this.filePath)) return {};
    return JSON.parse(readFileSync(this.filePath, "utf-8"));
  }

  private writeAll(data: Record<string, string>): void {
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  async set(ref: string, secret: string): Promise<void> {
    const key = machineKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(secret, "utf-8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const all = this.readAll();
    all[ref] = Buffer.concat([iv, tag, encrypted]).toString("base64");
    this.writeAll(all);
  }

  async get(ref: string): Promise<string | null> {
    const all = this.readAll();
    const raw = all[ref];
    if (!raw) return null;
    const buf = Buffer.from(raw, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const encrypted = buf.subarray(28);
    const key = machineKey();
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf-8");
  }

  async delete(ref: string): Promise<boolean> {
    const all = this.readAll();
    if (!(ref in all)) return false;
    delete all[ref];
    this.writeAll(all);
    return true;
  }
}

let instance: CredentialVault | undefined;

export function getCredentialVault(): CredentialVault {
  if (!instance) {
    instance = resolveMode() === "os" ? new OsKeytarVault() : new DevFileVault();
  }
  return instance;
}

/** Genera una referencia de credencial legible y única para guardar en channel_credentials.credentialRef. */
export function newCredentialRef(channelCode: string, purpose: string): string {
  return `${channelCode}:${purpose}:${randomBytes(6).toString("hex")}`;
}
