/**
 * Canales soportados por BLACK SAND Manager (sección D.4 / C de la especificación).
 * Meta se modela desde el día uno como canal de solo-catálogo (ads), nunca como
 * canal transaccional, mientras Chile no tenga Shopping/Marketplace habilitado.
 */
export const CHANNEL_CODES = ["shopify", "mercadolibre", "meta"] as const;
export type ChannelCode = (typeof CHANNEL_CODES)[number];

/**
 * Capacidades declaradas por conector (sección D.4). La UI nunca debe ofrecer
 * una acción que el conector no declare soportada — nunca se simula.
 */
export interface ChannelCapabilities {
  pushStock: boolean;
  pushPrice: boolean;
  pushProductCreate: boolean;
  pullOrders: boolean;
  pullAbandonedCheckouts: boolean;
  pullCustomers: boolean;
  bulkOperations: boolean;
}

export const CHANNEL_CAPABILITIES: Record<ChannelCode, ChannelCapabilities> = {
  shopify: {
    pushStock: true,
    pushPrice: true,
    pushProductCreate: true,
    pullOrders: true,
    pullAbandonedCheckouts: true, // sujeto a aprobación de protected customer data
    pullCustomers: true, // sujeto a aprobación de protected customer data
    bulkOperations: true,
  },
  mercadolibre: {
    pushStock: true,
    pushPrice: true,
    pushProductCreate: true,
    pullOrders: true,
    pullAbandonedCheckouts: false, // no existe el concepto vía API
    pullCustomers: false, // parcial: solo datos del comprador por pedido
    bulkOperations: false, // se emula con colas propias
  },
  meta: {
    pushStock: false,
    pushPrice: false,
    pushProductCreate: false,
    pullOrders: false,
    pullAbandonedCheckouts: false,
    pullCustomers: false,
    bulkOperations: false,
  },
};

/** Fase actual en la que cada canal pasa a estar activo, según la sección H del plan. */
export const CHANNEL_PHASE_1_READ_ONLY: Record<ChannelCode, boolean> = {
  shopify: true,
  mercadolibre: true,
  meta: true, // solo como generador de feed, sin publicar todavía
};
