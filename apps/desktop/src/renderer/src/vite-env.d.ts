/// <reference types="vite/client" />
import type { BlacksandApi } from "../../shared-ipc-types";

declare global {
  interface Window {
    blacksand: BlacksandApi;
  }
}

export {};
