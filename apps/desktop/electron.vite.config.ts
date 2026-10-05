import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

// Paquetes propios del monorepo: deben quedar EMPAQUETADOS (Vite los
// transpila de TS a JS), no externalizados — sus package.json apuntan a
// "src/index.ts" y Node no puede cargar .ts directo en tiempo de ejecución.
// Solo las dependencias reales de node_modules con binarios nativos
// (Prisma, keytar) deben seguir externalizadas.
const workspacePackages = [
  "@blacksand/shared",
  "@blacksand/db",
  "@blacksand/core-domain",
  "@blacksand/sync-engine",
  "@blacksand/credentials",
  "@blacksand/connector-shopify",
  "@blacksand/connector-mercadolibre",
  "@blacksand/connector-meta",
];

export default defineConfig({
  main: {
    // externalizeDepsPlugin evita que Vite intente empaquetar dependencias
    // nativas (motor de Prisma, keytar) — deben cargarse como módulos
    // normales de Node en el proceso principal de Electron. Se excluyen los
    // paquetes @blacksand/* de la externalización para que sí se empaqueten
    // (ver comentario arriba). Salida CJS (default): el código de
    // main/preload evita `import.meta.url`/`__dirname` y resuelve rutas con
    // `app.getAppPath()` para no depender del formato de módulo, que puede
    // variar entre versiones de Electron/electron-vite.
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
      },
    },
  },
  preload: {
    // Formato por defecto (CJS): la carga de preloads en ESM tiene más
    // matices entre versiones de Electron y no lo necesitamos aquí (este
    // archivo no usa import.meta.url).
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
  },
});
