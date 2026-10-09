/**
 * Lógica pura (sin red ni base de datos) del registro de días de despacho:
 * interpreta los correos de Blue Express / Mercado Libre y arma el resumen
 * mensual (días con despacho × tarifa diaria).
 */

export type ShippingCarrier = "BLUE_EXPRESS" | "MERCADO_LIBRE";

export interface ParsedShippingEmail {
  carrier: ShippingCarrier;
  /** YYYY-MM-DD, día calendario en que se dejaron los paquetes. */
  dispatchDay: string;
  packages: number;
  /** Números de orden de servicio (Blue Express) o de venta (Mercado Libre) que aparecen en el correo. */
  refs: string[];
}

const MONTHS: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Día calendario (YYYY-MM-DD) de una fecha según la hora de Chile. */
export function chileDay(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return parts; // en-CA => YYYY-MM-DD
}

function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** "7 de octubre" / "7 de octubre del 2026" / "7 de octubre de 2026" → YYYY-MM-DD (año por defecto: el del correo). */
function parseSpanishDate(text: string, fallbackYear: number): string | null {
  const m = normalize(text).match(/(\d{1,2})\s+de\s+([a-z]+)(?:\s+(?:del?|,)?\s*(\d{4}))?/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = MONTHS[m[2]];
  if (!month || day < 1 || day > 31) return null;
  const year = m[3] ? Number(m[3]) : fallbackYear;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Interpreta un correo. Devuelve `null` si no es un comprobante de despacho.
 * - Blue Express: asunto "[Blue Express] Admisión PickUp", cuerpo "...entregado el 7 de octubre del 2026 en Punto ...", "Total Ordenes de Servicio: 3".
 * - Mercado Libre: asunto "Comprobante de despacho del 7 de octubre", cuerpo "Despachaste 1 paquete(s)".
 */
export function parseShippingEmail(input: {
  from: string;
  subject: string;
  body: string;
  receivedAt: Date;
}): ParsedShippingEmail | null {
  const from = input.from.toLowerCase();
  const subject = normalize(input.subject);
  const body = input.body;
  const receivedYear = Number(chileDay(input.receivedAt).slice(0, 4));
  const receivedDay = chileDay(input.receivedAt);

  if (from.includes("bx.cl") || from.includes("bluex") || subject.includes("blue express")) {
    if (!subject.includes("admision") && !normalize(body).includes("admitido")) return null;
    const delivered = normalize(body).match(/entregado\s+el\s+(\d{1,2}\s+de\s+[a-z]+(?:\s+del?\s+\d{4})?)/);
    const day = (delivered && parseSpanishDate(delivered[1], receivedYear)) || receivedDay;
    const nb = normalize(body);
    const total = nb.match(/total\s+ordenes\s+de\s+servicio:?\s*(\d+)/);
    const block = nb.match(/orden(?:es)?\s+de\s+servicio:?([\s\S]*?)(?:que\s+fue\s+entregado|entregado\s+el|total\s+ordenes)/);
    const refs = [...new Set((block ? block[1] : "").match(/\d{6,}/g) ?? [])];
    return {
      carrier: "BLUE_EXPRESS",
      dispatchDay: day,
      packages: total ? Number(total[1]) : refs.length || 1,
      refs,
    };
  }

  if (from.includes("mercadolibre") || from.includes("mercadolivre")) {
    if (!subject.includes("comprobante de despacho")) return null;
    const day = parseSpanishDate(subject.replace(/^.*comprobante de despacho\s*/, ""), receivedYear) || receivedDay;
    const nb = normalize(body);
    const pk = nb.match(/despachaste\s+(\d+)\s+paquete/);
    const refs = [...new Set([...nb.matchAll(/n\S{0,2}\s*venta\s*:?\s*(\d{6,})/g)].map((m) => m[1]))];
    return { carrier: "MERCADO_LIBRE", dispatchDay: day, packages: pk ? Number(pk[1]) : refs.length || 1, refs };
  }

  return null;
}

export interface ShippingDaySummary {
  day: string; // YYYY-MM-DD
  /** Cuenta para el pago (correos o ajuste manual). */
  dispatched: boolean;
  /** ¿Hay correos de despacho ese día? */
  fromEmails: boolean;
  carriers: ShippingCarrier[];
  packages: number;
  /** Detalle por correo: transportista, paquetes y números de orden / venta. */
  events: { carrier: ShippingCarrier; packages: number; refs: string[] }[];
  /** Ajuste manual (null = sin ajuste). */
  override: boolean | null;
  note: string | null;
}

export interface ShippingMonthSummary {
  year: number;
  month: number; // 1-12
  daysInMonth: number;
  dispatchedDays: number;
  dailyRate: number;
  amount: number;
  days: ShippingDaySummary[];
}

export function buildShippingMonthSummary(input: {
  year: number;
  month: number;
  dailyRate: number;
  events: { carrier: ShippingCarrier; dispatchDay: string; packages: number; refs: string[] }[];
  overrides: { day: string; dispatched: boolean; note: string | null }[];
}): ShippingMonthSummary {
  const { year, month, dailyRate } = input;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const overrideByDay = new Map(input.overrides.map((o) => [o.day, o]));
  const days: ShippingDaySummary[] = [];
  let dispatchedDays = 0;

  for (let d = 1; d <= daysInMonth; d++) {
    const day = `${year}-${pad2(month)}-${pad2(d)}`;
    const evs = input.events.filter((e) => e.dispatchDay === day);
    const carriers = [...new Set(evs.map((e) => e.carrier))];
    const fromEmails = evs.length > 0;
    const ov = overrideByDay.get(day);
    const dispatched = ov ? ov.dispatched : fromEmails;
    if (dispatched) dispatchedDays += 1;
    days.push({
      day,
      dispatched,
      fromEmails,
      carriers,
      packages: evs.reduce((s, e) => s + e.packages, 0),
      events: evs.map((e) => ({ carrier: e.carrier, packages: e.packages, refs: e.refs })),
      override: ov ? ov.dispatched : null,
      note: ov?.note ?? null,
    });
  }

  return { year, month, daysInMonth, dispatchedDays, dailyRate, amount: dispatchedDays * dailyRate, days };
}
