import { useState, type ReactNode } from "react";

/**
 * A pedido del usuario: al ingresar atributos de Mercado Libre (sobre todo
 * las medidas y el peso del paquete), antes se mostraba siempre la
 * explicación completa de cada campo entre paréntesis junto a la etiqueta
 * — con varios campos seguidos, la pantalla se llenaba de oraciones largas
 * repetidas. Esto la esconde detrás de un ícono "ⓘ" chico que el usuario
 * puede desplegar solo si la necesita.
 */
export function InfoDisclosure({ children, label = "Mostrar explicación" }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="info-disclosure">
      <button
        type="button"
        className="info-disclosure-trigger"
        aria-label={label}
        title={label}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "×" : "ⓘ"}
      </button>
      {open && <span className="info-disclosure-text">{children}</span>}
    </span>
  );
}
