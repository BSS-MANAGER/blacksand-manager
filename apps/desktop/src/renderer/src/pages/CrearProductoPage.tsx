import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type { CreateProductResult } from "../../../shared-ipc-types";

/**
 * "Crear producto" — a pedido explícito del usuario: "mi idea es que
 * podamos trabajar para subir los productos desde la app, entonces de esta
 * forma yo subo un producto a la app y estos automáticamente se suben a
 * Shopify y ML". Decisiones que tomó el usuario antes de construir esto:
 * SKU único (sin variantes de color/talla), fotos elegidas directo desde su
 * computador (no URLs ya alojadas), y Mercado Libre automático en el mismo
 * acto de crear cuando la categoría del grupo ya está confirmada (ver
 * `createProductAndPublish`, @blacksand/sync-engine, y "Publicar en ML"
 * para la confirmación de categoría — esta pantalla no la duplica).
 */

interface FormState {
  name: string;
  sku: string;
  barcode: string;
  brand: string;
  category: string;
  price: string;
  quantityOnHand: string;
  description: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  sku: "",
  barcode: "",
  brand: "",
  category: "",
  price: "",
  quantityOnHand: "0",
  description: "",
};

function meliOutcomeMessage(meli: CreateProductResult["meli"]): { text: string; tone: "ok" | "warn" | "err" } {
  switch (meli.status) {
    case "no_conectado":
      return {
        text: "Mercado Libre no está conectado (falta OAuth en Configuración) — el producto quedó creado solo en Shopify.",
        tone: "warn",
      };
    case "categoria_sin_confirmar":
      return {
        text: `El producto quedó creado en Shopify. La categoría "${meli.groupKey}" todavía no está confirmada en Mercado Libre — confírmala una vez en "Publicar en ML" y este producto (y los próximos de esta misma categoría) se publicarán solos.`,
        tone: "warn",
      };
    case "publicado":
      return {
        text:
          meli.warnings.length > 0
            ? `Publicado también en Mercado Libre, con avisos: ${meli.warnings.join(" ")}`
            : "Publicado también en Mercado Libre.",
        tone: meli.warnings.length > 0 ? "warn" : "ok",
      };
    case "error":
      return { text: `No se pudo publicar en Mercado Libre: ${meli.reason}`, tone: "err" };
  }
}

export default function CrearProductoPage() {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [imagePaths, setImagePaths] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateProductResult | null>(null);

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function pickImages() {
    const picked = await window.blacksand.products.pickImages();
    if (picked.length === 0) return;
    setImagePaths((prev) => Array.from(new Set([...prev, ...picked])));
  }

  function removeImage(path: string) {
    setImagePaths((prev) => prev.filter((p) => p !== path));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const price = Number(form.price.replace(",", "."));
    const quantityOnHand = Number(form.quantityOnHand);

    if (!form.name.trim()) return setError("Falta el nombre del producto.");
    if (!form.sku.trim()) return setError("Falta el SKU.");
    if (!Number.isFinite(price) || price <= 0) return setError("El precio debe ser un número mayor a 0.");
    if (!Number.isFinite(quantityOnHand) || quantityOnHand < 0) return setError("El stock debe ser un número igual o mayor a 0.");
    if (imagePaths.length === 0) return setError("Agrega al menos una foto — Mercado Libre exige al menos una imagen.");

    setSaving(true);
    setResult(null);
    try {
      const created = await window.blacksand.products.createAndPublish({
        sku: form.sku.trim(),
        barcode: form.barcode.trim() || null,
        name: form.name.trim(),
        description: form.description.trim() || null,
        brand: form.brand.trim() || null,
        category: form.category.trim() || null,
        price,
        quantityOnHand,
        imagePaths,
      });
      setResult(created);
      setForm(EMPTY_FORM);
      setImagePaths([]);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h1>Crear producto</h1>
      <p className="page-subtitle">
        Crea un producto nuevo desde acá y se sube solo a Shopify y, si la categoría ya está confirmada, también a
        Mercado Libre — un SKU por producto (sin variantes de color/talla).
      </p>

      {error && <div className="error-banner">{error}</div>}

      {result && (
        <div className="card" style={{ borderColor: "var(--ok)" }}>
          <h2>Producto creado — SKU {result.sku}</h2>
          <p style={{ margin: "0 0 8px" }}>✅ Creado en Shopify.</p>
          {result.stockWarning && <p className="error-banner">{result.stockWarning}</p>}
          {result.imageWarnings.length > 0 && (
            <p className="error-banner">{result.imageWarnings.join(" ")}</p>
          )}
          {(() => {
            const { text, tone } = meliOutcomeMessage(result.meli);
            const cls = tone === "ok" ? "success-banner" : tone === "warn" ? "error-banner" : "error-banner";
            return (
              <p className={cls}>
                {text}
                {result.meli.status === "categoria_sin_confirmar" && (
                  <>
                    {" "}
                    <Link to="/publicar-meli">Ir a "Publicar en ML"</Link>
                  </>
                )}
              </p>
            );
          })()}
        </div>
      )}

      <form className="card" onSubmit={handleSubmit}>
        <div className="form-row">
          <label>Nombre del producto</label>
          <input value={form.name} onChange={(e) => updateField("name", e.target.value)} placeholder="Ej: Chaleco táctico Coyote" />
        </div>
        <div className="form-row">
          <label>SKU</label>
          <input value={form.sku} onChange={(e) => updateField("sku", e.target.value)} placeholder="Ej: EM-CHT-001" />
        </div>
        <div className="form-row">
          <label>Código de barras / GTIN (opcional)</label>
          <input value={form.barcode} onChange={(e) => updateField("barcode", e.target.value)} />
        </div>
        <div className="form-row">
          <label>Marca (opcional — si se deja vacío, se usa la "Marca por defecto" de Configuración al publicar en Mercado Libre)</label>
          <input value={form.brand} onChange={(e) => updateField("brand", e.target.value)} />
        </div>
        <div className="form-row">
          <label>Categoría (agrupa el producto para Mercado Libre — usa el mismo texto que ya usas para categorías existentes si quieres que reuse una categoría de Mercado Libre ya confirmada)</label>
          <input value={form.category} onChange={(e) => updateField("category", e.target.value)} />
        </div>
        <div className="form-row">
          <label>Precio de venta (Shopify — Mercado Libre se publica con el recargo configurado, redondeado)</label>
          <input value={form.price} onChange={(e) => updateField("price", e.target.value)} inputMode="decimal" placeholder="Ej: 24990" />
        </div>
        <div className="form-row">
          <label>Stock inicial</label>
          <input value={form.quantityOnHand} onChange={(e) => updateField("quantityOnHand", e.target.value)} inputMode="numeric" />
        </div>
        <div className="form-row" style={{ maxWidth: 600 }}>
          <label>Descripción (opcional)</label>
          <textarea
            value={form.description}
            onChange={(e) => updateField("description", e.target.value)}
            rows={4}
            style={{
              width: "100%",
              background: "var(--panel-2)",
              border: "1px solid var(--border)",
              color: "var(--text)",
              borderRadius: 8,
              padding: "8px 10px",
              fontSize: 13,
              fontFamily: "inherit",
            }}
          />
        </div>

        <div className="form-row" style={{ maxWidth: 600 }}>
          <label>Fotos (al menos una — Mercado Libre la exige)</label>
          <button type="button" className="secondary" onClick={pickImages} disabled={saving}>
            Elegir fotos…
          </button>
          {imagePaths.length > 0 && (
            <ul style={{ margin: "10px 0 0", padding: 0, listStyle: "none", fontSize: 12.5 }}>
              {imagePaths.map((path) => (
                <li key={path} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
                  <span style={{ color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {path.split(/[\\/]/).pop()}
                  </span>
                  <button type="button" className="secondary small" onClick={() => removeImage(path)} disabled={saving}>
                    Quitar
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <button type="submit" disabled={saving}>
          {saving ? "Creando…" : "Crear y publicar"}
        </button>
      </form>
    </div>
  );
}
