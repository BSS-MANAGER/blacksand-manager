import { Fragment, useEffect, useRef, useState } from "react";
import type {
  MeliAttributeSpecRow,
  MeliAttributeValueRow,
  MeliBulkCategoryPreviewRow,
  MeliCategoryPreviewResult,
  MeliCategorySearchResultRow,
  MeliDescriptionSyncResult,
  MeliKeywordOverrideRow,
  MeliListingTypeRow,
  MeliPublishBatchResult,
  MeliPublishGroupRow,
} from "../../../shared-ipc-types";
import { usePagination, paginate, Pagination } from "../lib/pagination";
import { RowActionsMenu } from "../lib/actions-menu";
import { InfoDisclosure } from "../lib/disclosure";

/** Respuestas del usuario para un atributo con lista fija de valores (id -> valor elegido). */
type AttributeAnswers = Record<string, { valueId: string; valueName: string }>;

const MODEL_ATTRIBUTE_NAME_PATTERN = /modelo/i;
const STANDARD_VALUE_NAME_PATTERN = /^est[aá]ndar$|^standard$/i;
const PACKAGING_ATTRIBUTE_NAME_PATTERN = /empaque/i;
const NO_PACKAGING_VALUE_NAME_PATTERN = /no\s+tiene\s+un\s+empaque/i;
const GENDER_ATTRIBUTE_NAME_PATTERN = /^g[eé]nero$/i;
const NO_GENDER_VALUE_NAME_PATTERN = /sin\s*g[eé]nero/i;
const MATERIAL_PRINCIPAL_ATTRIBUTE_NAME_PATTERN = /material\s*principal/i;
const NO_MATERIAL_VALUE_NAME_PATTERN = /^est[aá]ndar$|^standard$|sin\s*material/i;
const POLYESTER_VALUE_NAME_PATTERN = /poli[eé]ster/i;
/** Para elegir sola una opción de "sin GTIN" al automatizar todo el lote — ver `pickDefaultGtinValue`. */
const GTIN_ABSENCE_DEFAULT_VALUE_PATTERN = /gen[eé]rico|sin\s*gtin|no\s*tiene\s*gtin|no\s*aplica|no\s*identificad/i;

/**
 * El usuario pidió que "Modelo" quede precargado en "Standard" por defecto
 * (la mayoría de sus productos no tiene variantes de modelo real), que
 * "Empaque de fábrica" quede precargado en la opción "Mi producto no tiene
 * un empaque de esas características" (tampoco aplica a la mayoría), que
 * "Género" quede siempre en "Sin género", y que "Material principal" quede
 * en "Standard"/"sin material principal" o, si la categoría no tiene esa
 * opción, en "Poliéster" — los cuatro siguen siendo editables por grupo
 * antes de confirmar, por si algún grupo puntual necesita otro valor. Si la
 * categoría define el atributo como lista fija, se busca la opción
 * correspondiente entre sus valores; si no existe ninguna (o el atributo es
 * de texto libre para "Modelo"), se usa el texto tal cual o se deja sin
 * precargar para que el usuario elija. "Género" y "Material principal" se
 * agregan a `needsGroupDefault` aunque la categoría no los marque como
 * requeridos (ver `resolveGroupAttributeNeeds` en `@blacksand/core-domain`)
 * porque el usuario los quiere completos en TODOS los productos, no solo
 * cuando Mercado Libre los exige.
 *
 * "Talla" tampoco se resuelve acá — a diferencia de estos cuatro, el valor
 * puede variar producto a producto (según lo que tenga cargado en
 * Shopify), así que se resuelve por producto en `matchSizeAttributeValue`
 * (`@blacksand/core-domain`), igual que el color.
 *
 * "Precios mayoristas" NO se resuelve acá: se confirmó (investigando
 * directo contra el sitio de Mercado Libre) que no es un atributo de
 * categoría ni ningún otro campo expuesto por la API pública — es una
 * función interna del panel de vendedores sin equivalente en la API. Queda
 * como paso manual: el usuario activa la casilla y confirma dejando los
 * precios que Mercado Libre recomienda, en el sitio de Mercado Libre,
 * después de que la publicación ya existe.
 */
function defaultAttributeAnswers(preview: MeliCategoryPreviewResult): AttributeAnswers {
  const answers: AttributeAnswers = {};
  for (const attr of preview.groupNeeds.needsGroupDefault) {
    if (MODEL_ATTRIBUTE_NAME_PATTERN.test(attr.name)) {
      if (attr.values.length === 0) {
        answers[attr.id] = { valueId: "", valueName: "Standard" };
      } else {
        const standardValue = attr.values.find((v) => STANDARD_VALUE_NAME_PATTERN.test(v.name));
        if (standardValue) answers[attr.id] = { valueId: standardValue.id, valueName: standardValue.name };
      }
    } else if (PACKAGING_ATTRIBUTE_NAME_PATTERN.test(attr.name)) {
      const noPackagingValue = attr.values.find((v) => NO_PACKAGING_VALUE_NAME_PATTERN.test(v.name));
      if (noPackagingValue) answers[attr.id] = { valueId: noPackagingValue.id, valueName: noPackagingValue.name };
    } else if (GENDER_ATTRIBUTE_NAME_PATTERN.test(attr.name)) {
      const noGenderValue = attr.values.find((v) => NO_GENDER_VALUE_NAME_PATTERN.test(v.name));
      if (noGenderValue) answers[attr.id] = { valueId: noGenderValue.id, valueName: noGenderValue.name };
    } else if (MATERIAL_PRINCIPAL_ATTRIBUTE_NAME_PATTERN.test(attr.name)) {
      const noMaterialValue = attr.values.find((v) => NO_MATERIAL_VALUE_NAME_PATTERN.test(v.name));
      const polyesterValue = attr.values.find((v) => POLYESTER_VALUE_NAME_PATTERN.test(v.name));
      const chosen = noMaterialValue ?? polyesterValue;
      if (chosen) answers[attr.id] = { valueId: chosen.id, valueName: chosen.name };
    }
  }
  return answers;
}

/**
 * Al automatizar todo el lote no hay usuario mirando para elegir qué
 * declarar en categorías que exigen GTIN pero el producto no tiene código
 * de barras propio — se busca una opción cuyo nombre suene a "no tiene
 * GTIN"/"genérico" (mismo criterio de nombre-no-id que el resto de estos
 * defaults, Mercado Libre no usa un id fijo para esto) y, si ninguna
 * coincide, se usa la primera opción de la lista antes que dejar el grupo
 * sin procesar.
 */
function pickDefaultGtinValue(values: MeliAttributeValueRow[]): MeliAttributeValueRow | undefined {
  return values.find((v) => GTIN_ABSENCE_DEFAULT_VALUE_PATTERN.test(v.name)) ?? values[0];
}

export default function PublicarMeliPage() {
  const [groups, setGroups] = useState<MeliPublishGroupRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [customQuery, setCustomQuery] = useState("");
  const [preview, setPreview] = useState<MeliCategoryPreviewResult | null>(null);
  const [chosenCategory, setChosenCategory] = useState<{
    categoryId: string;
    categoryName: string;
    categoryPath?: string[];
  } | null>(null);
  const [listingTypes, setListingTypes] = useState<MeliListingTypeRow[] | null>(null);
  const [chosenListingTypeId, setChosenListingTypeId] = useState("");
  const [attributeAnswers, setAttributeAnswers] = useState<AttributeAnswers>({});
  const [gtinAnswerValueId, setGtinAnswerValueId] = useState("");
  // Productos ajustables de una sola talla (ej. chalecos tácticos): el
  // usuario pidió poder ignorar la talla que traiga Shopify y publicar
  // siempre "Standard" para todo el grupo — ver `forceStandardSize` en
  // `PublishGroupMapping` (@blacksand/core-domain).
  const [forceStandardSize, setForceStandardSize] = useState(false);
  // "Color por defecto": para categorías que EXIGEN color pero el producto
  // no tiene ninguno cargado en Shopify (caso real: "BARRIGUERA CON
  // CINTURON" — MLC440257 exige COLOR, Mercado Libre rechazó la
  // publicación con `item.attributes.missing_required`). Vacío = sin
  // default; ver `PublishGroupMapping.defaultColorValueId` (@blacksand/core-domain).
  const [defaultColorValueId, setDefaultColorValueId] = useState("");
  const [busy, setBusy] = useState(false);
  /**
   * Caso real encontrado (septiembre 2026): ~20 productos quedaron
   * publicados DOS VECES en Mercado Libre (dos `channelProductId` distintos
   * para el mismo producto/SKU) — los timestamps de auditoría mostraron cada
   * par creado 1-2 segundos aparte. La causa: "Publicar lote" y "Publicar
   * todo automáticamente" comparten el mismo fondo (ambos llaman a
   * `loadCandidateProducts` fresco y publican lo que encuentran pendiente),
   * y nada impedía que dos clics casi simultáneos (doble clic, o clickear
   * "Publicar lote" mientras "Publicar todo automáticamente" seguía
   * corriendo) ejecutaran los dos a la vez — el estado de React (`busy`/
   * `autoBusy` de abajo) deshabilita el botón recién en el PRÓXIMO render,
   * que no es sincrónico con el clic, así que un clic muy rápido alcanza a
   * pasar antes de que el botón se desactive. Un `ref` SÍ se actualiza de
   * forma sincrónica (sin esperar a React) — se revisa y marca al principio
   * de `runBatch`/`autoPublishAll`, ANTES de cualquier `await`, así un
   * segundo clic casi inmediato encuentra el candado ya puesto y no hace
   * nada en vez de disparar una publicación duplicada.
   */
  const publishGuardRef = useRef(false);

  const [batchLimits, setBatchLimits] = useState<Record<string, number>>({});
  const [batchResults, setBatchResults] = useState<Record<string, MeliPublishBatchResult>>({});

  // "Publicar todo automáticamente": revisa categoría + confirma mapeo (con
  // los mismos defaults de `defaultAttributeAnswers`/`pickDefaultGtinValue`
  // que ya se ven precargados al abrir un grupo a mano) + publica el lote
  // completo, para todos los grupos candidatos en una sola pasada.
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoSummary, setAutoSummary] = useState<{
    groupsConfirmed: number;
    totalCreated: number;
    totalAttempted: number;
    groupsFailed: { groupKey: string; reason: string }[];
  } | null>(null);

  // Copia la descripción de Shopify a lo que ya está publicado en Mercado
  // Libre — corre solo cada cierto tiempo en segundo plano (`main/index.ts`),
  // este botón lo fuerza de inmediato para no tener que esperar.
  const [descriptionSyncBusy, setDescriptionSyncBusy] = useState(false);
  const [descriptionSyncResult, setDescriptionSyncResult] = useState<MeliDescriptionSyncResult | null>(null);

  // "Categorías por palabra clave": lista de categorías verificadas a mano
  // (ver el comentario grande en `findKeywordOverride`, @blacksand/core-domain)
  // que "Publicar todo automáticamente" usa para no depender a ciegas de la
  // predicción de texto de Mercado Libre.
  const [keywordOverrides, setKeywordOverrides] = useState<MeliKeywordOverrideRow[] | null>(null);
  const [newOverrideKeyword, setNewOverrideKeyword] = useState("");
  const [categorySearchQuery, setCategorySearchQuery] = useState("");
  const [categorySearchResults, setCategorySearchResults] = useState<MeliCategorySearchResultRow[] | null>(null);
  const [categorySearchBusy, setCategorySearchBusy] = useState(false);
  const [overrideSaveBusy, setOverrideSaveBusy] = useState(false);

  // "Revisión masiva de categorías": trae la predicción de TODOS los
  // grupos pendientes de una vez (en vez de abrir "Revisar categoría" uno
  // por uno) para repasarlas y confirmarlas en una sola pasada. A
  // diferencia de "Publicar todo automáticamente", esto SOLO confirma
  // categorías — nunca publica nada — para que el usuario pueda ir
  // subiendo productos de a poco (por su cuenta, con "Publicar lote") una
  // vez que confía en la categoría de cada grupo.
  const [bulkRows, setBulkRows] = useState<MeliBulkCategoryPreviewRow[] | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkChoices, setBulkChoices] = useState<
    Record<
      string,
      {
        excluded: boolean;
        saveKeyword: boolean;
        keyword: string;
        forceStandardSize: boolean;
        /** Ver el comentario de `defaultColorValueId` más arriba — vacío = sin default de color para este grupo. */
        defaultColorValueId: string;
      }
    >
  >({});
  const [bulkConfirmBusy, setBulkConfirmBusy] = useState(false);
  const [bulkSummary, setBulkSummary] = useState<{
    confirmed: number;
    skipped: number;
    errors: { groupKey: string; reason: string }[];
  } | null>(null);

  // El panel de confirmación de categoría se agrega DEBAJO de la tabla de
  // grupos — con varios grupos en la tabla, el panel queda fuera de la
  // pantalla y un clic en "Revisar categoría" puede parecer que "no hizo
  // nada" si el usuario no baja el scroll a mano. Se hace scroll automático
  // en cuanto se abre un grupo.
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selectedGroup) {
      panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [selectedGroup]);

  async function loadGroups() {
    try {
      setGroups(await window.blacksand.meliPublish.listCandidateGroups());
    } catch (err) {
      setError(String(err));
    }
  }

  async function loadKeywordOverrides() {
    try {
      setKeywordOverrides(await window.blacksand.meliPublish.listKeywordOverrides());
    } catch (err) {
      setError(String(err));
    }
  }

  useEffect(() => {
    loadGroups();
    loadKeywordOverrides();
  }, []);

  async function searchCategoriesForOverride() {
    if (!categorySearchQuery.trim()) return;
    setCategorySearchBusy(true);
    setError(null);
    try {
      setCategorySearchResults(await window.blacksand.meliPublish.searchCategories(categorySearchQuery));
    } catch (err) {
      setError(String(err));
    } finally {
      setCategorySearchBusy(false);
    }
  }

  async function saveOverride(category: MeliCategorySearchResultRow) {
    if (!newOverrideKeyword.trim()) {
      setError('Escribe primero la "Palabra clave" (ej. "bandana") antes de elegir una categoría.');
      return;
    }
    setOverrideSaveBusy(true);
    setError(null);
    setMessage(null);
    try {
      await window.blacksand.meliPublish.saveKeywordOverride({
        keyword: newOverrideKeyword.trim(),
        categoryId: category.categoryId,
        categoryName: category.categoryName,
      });
      setMessage(`Guardado: los productos con "${newOverrideKeyword.trim()}" en el nombre van a "${category.categoryName}".`);
      setNewOverrideKeyword("");
      setCategorySearchQuery("");
      setCategorySearchResults(null);
      await loadKeywordOverrides();
    } catch (err) {
      setError(String(err));
    } finally {
      setOverrideSaveBusy(false);
    }
  }

  async function removeOverride(id: string) {
    setError(null);
    try {
      await window.blacksand.meliPublish.deleteKeywordOverride(id);
      await loadKeywordOverrides();
    } catch (err) {
      setError(String(err));
    }
  }

  /**
   * "Revisar todas las categorías pendientes": trae la predicción de cada
   * grupo pendiente de una sola vez y arma un choice por defecto para cada
   * uno — excluido automáticamente cuando exige guía de talles (esta app
   * no la soporta, ver `requiresSizeGuide`), incluido si no. El checkbox
   * "guardar como palabra clave" sale marcado solo cuando la categoría
   * TODAVÍA no viene de una palabra clave (si ya vino de una, no hace
   * falta volver a guardarla).
   */
  async function runBulkPreview() {
    setBulkBusy(true);
    setError(null);
    setBulkSummary(null);
    try {
      const rows = await window.blacksand.meliPublish.previewAllPendingCategories();
      setBulkRows(rows);
      const choices: typeof bulkChoices = {};
      for (const row of rows) {
        choices[row.groupKey] = {
          excluded: row.preview.groupNeeds.requiresSizeGuide || row.preview.predictions.length === 0,
          saveKeyword: row.preview.categorySource === "ml_prediction",
          keyword: row.suggestedKeyword,
          forceStandardSize: false,
          defaultColorValueId: "",
        };
      }
      setBulkChoices(choices);
    } catch (err) {
      setError(String(err));
    } finally {
      setBulkBusy(false);
    }
  }

  function setBulkChoice(
    groupKey: string,
    patch: Partial<{
      excluded: boolean;
      saveKeyword: boolean;
      keyword: string;
      forceStandardSize: boolean;
      defaultColorValueId: string;
    }>,
  ) {
    setBulkChoices((prev) => ({ ...prev, [groupKey]: { ...prev[groupKey]!, ...patch } }));
  }

  /**
   * Confirma la categoría de cada fila NO excluida (con los mismos
   * defaults de atributos que ya usa "Publicar todo automáticamente":
   * `defaultAttributeAnswers`/`pickDefaultGtinValue`) y, si el checkbox
   * está marcado, guarda también la palabra clave — todo en una pasada,
   * sin publicar nada todavía (publicar sigue siendo un paso aparte y
   * deliberado, por grupo, con "Publicar lote").
   */
  async function confirmBulkSelected() {
    if (!bulkRows) return;
    setBulkConfirmBusy(true);
    setError(null);
    try {
      let types = listingTypes;
      if (!types || types.length === 0) {
        types = await window.blacksand.meliPublish.getListingTypes();
        setListingTypes(types);
      }
      if (!types[0]) throw new Error("Mercado Libre no devolvió ningún tipo de publicación disponible.");
      const defaultListingTypeId = types[0].id;

      let confirmed = 0;
      let skipped = 0;
      const errors: { groupKey: string; reason: string }[] = [];

      for (const row of bulkRows) {
        const choice = bulkChoices[row.groupKey];
        if (!choice || choice.excluded) {
          skipped++;
          continue;
        }
        const category = row.preview.predictions[0];
        if (!category) {
          errors.push({ groupKey: row.groupKey, reason: "Sin categoría predicha" });
          continue;
        }
        try {
          const answers = defaultAttributeAnswers(row.preview);
          const missing = row.preview.groupNeeds.needsGroupDefault.filter(
            (a) => a.required && !answers[a.id]?.valueId && !answers[a.id]?.valueName?.trim(),
          );
          if (missing.length > 0) {
            throw new Error(`Falta elegir a mano un valor para: ${missing.map((a) => a.name).join(", ")}`);
          }
          const gtinFallback = row.preview.groupNeeds.gtinFallback;
          const gtinValue = gtinFallback ? pickDefaultGtinValue(gtinFallback.values) : undefined;
          if (gtinFallback && !gtinValue) {
            throw new Error('Esta categoría exige GTIN y no hay ninguna opción para declarar "sin GTIN"');
          }

          // No se exige acá (a diferencia de GTIN, la mayoría de los
          // productos SÍ tiene color cargado en Shopify) — es opcional,
          // pensado como respaldo para los productos puntuales del grupo
          // que no tengan color propio. Si falta y hace falta, el producto
          // puntual queda como error claro en el resumen de "Publicar
          // lote" (ver `buildCreateItemPayload` en @blacksand/core-domain),
          // sin bloquear la confirmación de todo el grupo.
          const colorValue = choice.defaultColorValueId
            ? row.preview.groupNeeds.colorValues.find((v) => v.id === choice.defaultColorValueId)
            : undefined;

          await window.blacksand.meliPublish.confirmGroupMapping({
            groupKey: row.groupKey,
            categoryId: category.categoryId,
            categoryName: category.categoryName,
            listingTypeId: defaultListingTypeId,
            attributeDefaults: Object.entries(answers).map(([id, v]) => ({ id, valueId: v.valueId, valueName: v.valueName })),
            emptyGtinAttributeId: gtinFallback?.attributeId,
            emptyGtinValueId: gtinValue?.id,
            emptyGtinValueName: gtinValue?.name,
            forceStandardSize: choice.forceStandardSize,
            defaultColorValueId: colorValue?.id,
            defaultColorValueName: colorValue?.name,
          });

          if (choice.saveKeyword && choice.keyword.trim()) {
            await window.blacksand.meliPublish.saveKeywordOverride({
              keyword: choice.keyword.trim(),
              categoryId: category.categoryId,
              categoryName: category.categoryName,
            });
          }
          confirmed++;
        } catch (err) {
          errors.push({ groupKey: row.groupKey, reason: err instanceof Error ? err.message : String(err) });
        }
      }

      setBulkSummary({ confirmed, skipped, errors });
      setBulkRows(null);
      await loadGroups();
      await loadKeywordOverrides();
    } catch (err) {
      setError(String(err));
    } finally {
      setBulkConfirmBusy(false);
    }
  }

  async function openGroup(groupKey: string) {
    setSelectedGroup(groupKey);
    setPreview(null);
    setChosenCategory(null);
    setAttributeAnswers({});
    setGtinAnswerValueId("");
    setForceStandardSize(false);
    setDefaultColorValueId("");
    setCustomQuery("");
    setError(null);
    setBusy(true);
    try {
      const [previewResult, types] = await Promise.all([
        window.blacksand.meliPublish.previewCategory(groupKey, undefined, true),
        listingTypes ?? window.blacksand.meliPublish.getListingTypes(),
      ]);
      setPreview(previewResult);
      setAttributeAnswers(defaultAttributeAnswers(previewResult));
      if (previewResult.predictions[0]) setChosenCategory(previewResult.predictions[0]);
      if (!listingTypes) setListingTypes(types);
      if (types[0]) setChosenListingTypeId(types[0].id);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function searchOtherCategory() {
    if (!selectedGroup || !customQuery.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.blacksand.meliPublish.previewCategory(selectedGroup, customQuery, true);
      setPreview(result);
      setAttributeAnswers(defaultAttributeAnswers(result));
      setGtinAnswerValueId("");
      setForceStandardSize(false);
      setDefaultColorValueId("");
      if (result.predictions[0]) setChosenCategory(result.predictions[0]);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  function setAttributeAnswer(attr: MeliAttributeSpecRow, valueId: string) {
    const value = attr.values.find((v) => v.id === valueId);
    if (!value) return;
    setAttributeAnswers((prev) => ({ ...prev, [attr.id]: { valueId: value.id, valueName: value.name } }));
  }

  /** Para atributos requeridos sin lista fija de opciones (texto libre — p. ej. "Modelo" o las dimensiones del paquete). */
  function setFreeTextAnswer(attrId: string, text: string) {
    setAttributeAnswers((prev) => ({ ...prev, [attrId]: { valueId: "", valueName: text } }));
  }

  async function confirmMapping() {
    if (!selectedGroup || !preview || !chosenCategory) return;
    // Los atributos opcionales (hoy: las 4 medidas de paquete) no bloquean
    // la confirmación — se completan solos con los datos de Shopify de
    // cada producto; acá solo se exige lo que de verdad no tiene otra
    // fuente (marca/GTIN ya se resuelven por producto aparte).
    const missing = (preview.groupNeeds.needsGroupDefault ?? []).filter(
      (a) => a.required && !attributeAnswers[a.id]?.valueId && !attributeAnswers[a.id]?.valueName?.trim(),
    );
    if (missing.length > 0) {
      setError(`Falta elegir un valor para: ${missing.map((a) => a.name).join(", ")}`);
      return;
    }
    if (preview.groupNeeds.gtinFallback && !gtinAnswerValueId) {
      setError('Esta categoría exige GTIN — elige qué declarar para productos sin código de barras ("sin GTIN").');
      return;
    }

    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const gtinFallback = preview.groupNeeds.gtinFallback;
      const gtinValue = gtinFallback?.values.find((v) => v.id === gtinAnswerValueId);
      const colorValue = defaultColorValueId
        ? preview.groupNeeds.colorValues.find((v) => v.id === defaultColorValueId)
        : undefined;

      await window.blacksand.meliPublish.confirmGroupMapping({
        groupKey: selectedGroup,
        categoryId: chosenCategory.categoryId,
        categoryName: chosenCategory.categoryName,
        listingTypeId: chosenListingTypeId,
        attributeDefaults: Object.entries(attributeAnswers).map(([id, v]) => ({
          id,
          valueId: v.valueId,
          valueName: v.valueName,
        })),
        emptyGtinAttributeId: gtinFallback?.attributeId,
        emptyGtinValueId: gtinValue?.id,
        emptyGtinValueName: gtinValue?.name,
        forceStandardSize,
        defaultColorValueId: colorValue?.id,
        defaultColorValueName: colorValue?.name,
      });
      setMessage(`Categoría confirmada para "${selectedGroup}": ${chosenCategory.categoryName}.`);
      setSelectedGroup(null);
      setPreview(null);
      await loadGroups();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function syncDescriptionsNow() {
    setDescriptionSyncBusy(true);
    setError(null);
    try {
      setDescriptionSyncResult(await window.blacksand.meliPublish.syncDescriptions());
    } catch (err) {
      setError(String(err));
    } finally {
      setDescriptionSyncBusy(false);
    }
  }

  async function runBatch(groupKey: string, defaultLimit: number) {
    // Ver el comentario grande de `publishGuardRef` más arriba.
    if (publishGuardRef.current) return;
    publishGuardRef.current = true;
    setBusy(true);
    setError(null);
    try {
      // Si el usuario nunca tocó el input, publicar todo lo que tiene ese
      // grupo en Shopify (mismo valor que ya se ve precargado en la
      // pantalla) — no un tope arbitrario.
      const limit = batchLimits[groupKey] ?? defaultLimit;
      const result = await window.blacksand.meliPublish.runBatch(groupKey, limit);
      setBatchResults((prev) => ({ ...prev, [groupKey]: result }));
      await loadGroups();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
      publishGuardRef.current = false;
    }
  }

  /**
   * Botón "Publicar todo automáticamente": para cada grupo candidato, sin
   * pedirle nada al usuario —
   *   1. Si el grupo no está confirmado, lo revisa (`previewCategory`) y lo
   *      confirma con la categoría mejor predicha y los mismos defaults que
   *      ya se precargan al abrir un grupo a mano (`defaultAttributeAnswers`,
   *      primer tipo de publicación, `pickDefaultGtinValue` si la categoría
   *      exige GTIN).
   *   2. Publica el lote completo del grupo (todos los productos que tiene
   *      pendientes en Shopify).
   *
   * Un grupo puntual que no se pueda resolver solo (sin categoría
   * encontrada, o un atributo requerido sin ningún default aplicable) NO
   * frena al resto — queda sin confirmar y aparece en el resumen para
   * revisarlo a mano, como cualquier otro grupo pendiente en la tabla.
   */
  async function autoPublishAll() {
    // Ver el comentario grande de `publishGuardRef` más arriba.
    if (publishGuardRef.current) return;
    publishGuardRef.current = true;
    setAutoBusy(true);
    setError(null);
    setMessage(null);
    setAutoSummary(null);
    try {
      const freshGroups = await window.blacksand.meliPublish.listCandidateGroups();
      let types = listingTypes;
      if (!types || types.length === 0) {
        types = await window.blacksand.meliPublish.getListingTypes();
        setListingTypes(types);
      }
      if (!types[0]) {
        throw new Error("Mercado Libre no devolvió ningún tipo de publicación disponible.");
      }
      const defaultListingTypeId = types[0].id;

      let groupsConfirmed = 0;
      let totalCreated = 0;
      let totalAttempted = 0;
      const groupsFailed: { groupKey: string; reason: string }[] = [];

      for (const g of freshGroups) {
        try {
          if (!g.confirmed) {
            const previewResult = await window.blacksand.meliPublish.previewCategory(g.groupKey);
            const category = previewResult.predictions[0];
            if (!category) {
              throw new Error("Mercado Libre no encontró ninguna categoría para este grupo");
            }
            // Ver el comentario en `findKeywordOverride` (@blacksand/core-domain):
            // la predicción de texto de Mercado Libre puede estar francamente
            // equivocada (confirmado con una "bandana táctica" real predicha
            // en "Bastones"), así que "Publicar todo automáticamente" solo
            // confirma sola una categoría NUEVA cuando salió de una palabra
            // clave que el usuario ya verificó a mano — el resto queda para
            // revisión manual en vez de arriesgarse a publicar mal.
            if (previewResult.categorySource !== "keyword_override") {
              throw new Error(
                `Mercado Libre predijo "${category.categoryName}" para este grupo, pero nadie la verificó a mano todavía — revísala en "Revisar categoría" (botón abajo), o guarda una palabra clave para este tipo de producto en "Categorías por palabra clave" y repite "Publicar todo automáticamente".`,
              );
            }
            if (previewResult.groupNeeds.requiresSizeGuide) {
              throw new Error(
                `La categoría "${category.categoryName}" exige una guía de talles que esta app todavía no crea — busca otra categoría a mano (ej. "accesorios" o "equipamiento" en vez de "ropa") en "Revisar categoría"`,
              );
            }

            const answers = defaultAttributeAnswers(previewResult);
            const missing = previewResult.groupNeeds.needsGroupDefault.filter(
              (a) => a.required && !answers[a.id]?.valueId && !answers[a.id]?.valueName?.trim(),
            );
            if (missing.length > 0) {
              throw new Error(
                `Falta elegir a mano un valor para: ${missing.map((a) => a.name).join(", ")}`,
              );
            }

            const gtinFallback = previewResult.groupNeeds.gtinFallback;
            const gtinValue = gtinFallback ? pickDefaultGtinValue(gtinFallback.values) : undefined;
            if (gtinFallback && !gtinValue) {
              throw new Error('Esta categoría exige GTIN y no hay ninguna opción para declarar "sin GTIN"');
            }

            await window.blacksand.meliPublish.confirmGroupMapping({
              groupKey: g.groupKey,
              categoryId: category.categoryId,
              categoryName: category.categoryName,
              listingTypeId: defaultListingTypeId,
              attributeDefaults: Object.entries(answers).map(([id, v]) => ({
                id,
                valueId: v.valueId,
                valueName: v.valueName,
              })),
              emptyGtinAttributeId: gtinFallback?.attributeId,
              emptyGtinValueId: gtinValue?.id,
              emptyGtinValueName: gtinValue?.name,
            });
            groupsConfirmed++;
          }

          const result = await window.blacksand.meliPublish.runBatch(g.groupKey, g.productCount);
          setBatchResults((prev) => ({ ...prev, [g.groupKey]: result }));
          totalCreated += result.created;
          totalAttempted += result.attempted;
        } catch (err) {
          groupsFailed.push({ groupKey: g.groupKey, reason: String(err) });
        }
      }

      setAutoSummary({ groupsConfirmed, totalCreated, totalAttempted, groupsFailed });
      await loadGroups();
    } catch (err) {
      setError(String(err));
    } finally {
      setAutoBusy(false);
      publishGuardRef.current = false;
    }
  }

  // A pedido del usuario: las tres listas de esta pantalla (grupos
  // candidatos, revisión masiva y palabras clave guardadas) se paginan de
  // a 10 para que la sección no se haga interminable con un catálogo
  // grande.
  const groupsPg = usePagination(groups?.length ?? 0);
  const pageGroups = groups ? paginate(groups, groupsPg.start, groupsPg.end) : null;
  const bulkRowsPg = usePagination(bulkRows?.length ?? 0);
  const pageBulkRows = bulkRows ? paginate(bulkRows, bulkRowsPg.start, bulkRowsPg.end) : null;
  const keywordOverridesPg = usePagination(keywordOverrides?.length ?? 0);
  const pageKeywordOverrides = keywordOverrides ? paginate(keywordOverrides, keywordOverridesPg.start, keywordOverridesPg.end) : null;

  return (
    <div>
      <h1>Publicar en Mercado Libre</h1>
      <p className="page-subtitle">
        Productos que ya existen en Shopify y todavía no en Mercado Libre, agrupados por categoría de
        Shopify — se confirma la categoría/atributos de Mercado Libre una vez por grupo, y esa
        confirmación se reusa para publicar cada producto del grupo. Una vez publicado con el mismo
        SKU, la pantalla Productos lo muestra como una sola fila (puede requerir correr "Importar de
        Mercado Libre" una vez más).
      </p>

      {error && <div className="error-banner">{error}</div>}
      {message && <div className="success-banner">{message}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <strong>Publicar todo automáticamente</strong>
            <div style={{ fontSize: 13, color: "var(--text-dim)" }}>
              Para cada grupo pendiente: si ya tiene categoría confirmada (a mano, o por una palabra
              clave guardada abajo), publica el lote completo directo. Un grupo NUEVO solo se
              confirma solo cuando su nombre calza con una palabra clave guardada en "Categorías por
              palabra clave" — si no, queda sin tocar para que lo revises a mano en "Revisar
              categoría" (Mercado Libre puede predecir categorías francamente equivocadas para un
              catálogo de nicho, y una publicación en la categoría incorrecta termina pausada). El
              resto de los grupos sigue publicándose igual en el mismo clic.
            </div>
          </div>
          <button onClick={autoPublishAll} disabled={autoBusy || busy || !groups || groups.length === 0}>
            {autoBusy ? "Publicando todo…" : "Publicar todo automáticamente"}
          </button>
        </div>
        {autoSummary && (
          <div style={{ marginTop: 10, fontSize: 13 }}>
            {autoSummary.groupsConfirmed} categoría(s) confirmada(s) automático, {autoSummary.totalCreated}{" "}
            publicaciones creadas de {autoSummary.totalAttempted} intentadas en total.
            {autoSummary.groupsFailed.length > 0 && (
              <>
                <div style={{ marginTop: 6, color: "var(--danger, #c0392b)" }}>
                  {autoSummary.groupsFailed.length} grupo(s) quedaron sin procesar — revisar a mano en
                  la tabla de abajo:
                </div>
                <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                  {autoSummary.groupsFailed.map((f, i) => (
                    <li key={i}>
                      {f.groupKey}: {f.reason}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <strong>Revisión masiva de categorías</strong>
            <div style={{ fontSize: 13, color: "var(--text-dim)" }}>
              Trae la predicción de categoría de TODOS los grupos pendientes de una sola vez, para
              repasarlas en una sola tabla en vez de abrir "Revisar categoría" uno por uno. Este botón
              SOLO confirma categorías — no publica nada — así puedes ir subiendo productos de a poco
              por tu cuenta con "Publicar lote" una vez que confías en la categoría de cada grupo. Los
              grupos que exigen guía de talles quedan excluidos automáticamente (no soportado todavía).
            </div>
          </div>
          <button onClick={runBulkPreview} disabled={bulkBusy || busy || autoBusy || !groups || groups.length === 0}>
            {bulkBusy ? "Consultando…" : "Revisar todas las categorías pendientes"}
          </button>
        </div>

        {bulkSummary && (
          <div style={{ marginTop: 10, fontSize: 13 }}>
            {bulkSummary.confirmed} categoría(s) confirmada(s), {bulkSummary.skipped} excluida(s) de esta
            pasada.
            {bulkSummary.errors.length > 0 && (
              <ul style={{ margin: "4px 0 0", paddingLeft: 18, color: "var(--danger, #c0392b)" }}>
                {bulkSummary.errors.map((e, i) => (
                  <li key={i}>
                    {e.groupKey}: {e.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {bulkRows && (
          <div style={{ marginTop: 12 }}>
            {bulkRows.length === 0 ? (
              <div className="empty-state">No hay grupos pendientes de revisar. 🎉</div>
            ) : (
              <>
                <table style={{ marginBottom: 12 }}>
                  <thead>
                    <tr>
                      <th>Incluir</th>
                      <th>Grupo</th>
                      <th>Categoría propuesta</th>
                      <th>Talla siempre "Standard"</th>
                      <th>Color por defecto (si falta en Shopify)</th>
                      <th>Guardar como palabra clave</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageBulkRows!.map((row) => {
                      const choice = bulkChoices[row.groupKey];
                      const category = row.preview.predictions[0];
                      const sizeGuideBlocked = row.preview.groupNeeds.requiresSizeGuide;
                      return (
                        <tr key={row.groupKey}>
                          <td>
                            <input
                              type="checkbox"
                              checked={!choice?.excluded}
                              disabled={sizeGuideBlocked || !category}
                              onChange={(e) => setBulkChoice(row.groupKey, { excluded: !e.target.checked })}
                            />
                          </td>
                          <td>
                            <div>{row.groupKey.startsWith("sku:") ? row.sampleProductName : row.groupKey}</div>
                            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                              {row.productCount} producto(s) · ej.: {row.sampleProductName}
                            </div>
                          </td>
                          <td>
                            {!category ? (
                              <span style={{ color: "var(--danger, #c0392b)" }}>Sin categoría encontrada</span>
                            ) : (
                              <>
                                <div>
                                  {category.categoryName} ({category.categoryId})
                                </div>
                                {/* Pedido real del usuario: "Cascos" (y otros nombres) se repite
                                    en ramas del árbol de Mercado Libre totalmente distintas — el
                                    camino completo acá permite detectar una predicción equivocada
                                    de un vistazo, sin tener que abrir cada grupo uno por uno. */}
                                {category.categoryPath && category.categoryPath.length > 0 && (
                                  <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                                    {category.categoryPath.join(" › ")}
                                  </div>
                                )}
                                <div style={{ fontSize: 11 }}>
                                  {row.preview.categorySource === "keyword_override"
                                    ? "✓ verificada (palabra clave)"
                                    : "⚠ predicción de Mercado Libre, sin verificar"}
                                  {sizeGuideBlocked && " — exige guía de talles, revisar a mano"}
                                </div>
                              </>
                            )}
                          </td>
                          <td>
                            {row.preview.groupNeeds.hasSizeAttribute && (
                              <input
                                type="checkbox"
                                checked={choice?.forceStandardSize ?? false}
                                disabled={choice?.excluded}
                                title='Ignora la talla de Shopify y publica siempre "Standard" — para productos ajustables de una sola talla, como chalecos tácticos.'
                                onChange={(e) => setBulkChoice(row.groupKey, { forceStandardSize: e.target.checked })}
                              />
                            )}
                          </td>
                          <td>
                            {row.preview.groupNeeds.colorRequired && (
                              <select
                                style={{ width: 150 }}
                                value={choice?.defaultColorValueId ?? ""}
                                disabled={choice?.excluded}
                                title='Esta categoría exige color. Se usa solo para productos de este grupo que no tengan color cargado en Shopify — si tienen, se usa el de Shopify igual que siempre.'
                                onChange={(e) => setBulkChoice(row.groupKey, { defaultColorValueId: e.target.value })}
                              >
                                <option value="">(sin default — puede fallar si falta color)</option>
                                {row.preview.groupNeeds.colorValues.map((v) => (
                                  <option key={v.id} value={v.id}>
                                    {v.name}
                                  </option>
                                ))}
                              </select>
                            )}
                          </td>
                          <td>
                            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                              <input
                                type="checkbox"
                                checked={choice?.saveKeyword ?? false}
                                disabled={choice?.excluded}
                                onChange={(e) => setBulkChoice(row.groupKey, { saveKeyword: e.target.checked })}
                              />
                              <input
                                style={{ width: 140 }}
                                value={choice?.keyword ?? ""}
                                disabled={choice?.excluded || !choice?.saveKeyword}
                                onChange={(e) => setBulkChoice(row.groupKey, { keyword: e.target.value })}
                              />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <Pagination page={bulkRowsPg.page} totalPages={bulkRowsPg.totalPages} totalItems={bulkRows.length} pageSize={bulkRowsPg.pageSize} onChange={bulkRowsPg.setPage} />
                <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                  <button disabled={bulkConfirmBusy} onClick={confirmBulkSelected}>
                    {bulkConfirmBusy ? "Confirmando…" : "Confirmar categorías seleccionadas"}
                  </button>
                  <button className="secondary" disabled={bulkConfirmBusy} onClick={() => setBulkRows(null)}>
                    Cancelar
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <strong>Descripciones</strong>
            <div style={{ fontSize: 13, color: "var(--text-dim)" }}>
              Copia la descripción actual de Shopify a todos los productos que ya están publicados en
              Mercado Libre (funciona solo en segundo plano cada 30 minutos; este botón lo fuerza de
              inmediato).
            </div>
          </div>
          <button onClick={syncDescriptionsNow} disabled={descriptionSyncBusy}>
            {descriptionSyncBusy ? "Sincronizando…" : "Sincronizar descripciones ahora"}
          </button>
        </div>
        {descriptionSyncResult && (
          <div style={{ marginTop: 10, fontSize: 13 }}>
            {descriptionSyncResult.updated} actualizadas, {descriptionSyncResult.unchanged} ya estaban al día
            (sin cambios, no se tocaron), {descriptionSyncResult.skipped} sin texto aprovechable en Shopify, de{" "}
            {descriptionSyncResult.attempted} publicadas en Mercado Libre.
            {descriptionSyncResult.errors.length > 0 && (
              <ul style={{ color: "var(--danger, #c0392b)" }}>
                {descriptionSyncResult.errors.map((e, i) => (
                  <li key={i}>
                    {e.productName} ({e.sku}): {e.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <strong>Precios mayoristas</strong>
        <div style={{ fontSize: 13, color: "var(--text-dim)" }}>
          "Precios mayoristas" no se puede activar por la API pública de Mercado Libre — es una
          función interna del panel de vendedores, sin equivalente en la API. Después de publicar
          cada producto, actívala manualmente en el sitio de Mercado Libre (en "Condiciones de
          venta" de esa publicación) dejando los precios que Mercado Libre recomienda por defecto,
          sin editarlos.
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <strong>Categorías por palabra clave</strong>
        <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 10 }}>
          Mercado Libre puede predecir categorías equivocadas para un catálogo de nicho (ej. una
          "bandana táctica" predicha en "Artículos deportivos &gt; Bastones") — una publicación en
          la categoría incorrecta termina pausada. Guarda acá, una vez por tipo de producto, la
          categoría real (búscala abajo y confírmala vos mismo) — "Publicar todo automáticamente"
          solo confirma sola una categoría nueva cuando el nombre del producto contiene una de
          estas palabras clave; el resto siempre queda para que lo revises a mano.
        </div>

        {keywordOverrides === null ? (
          <div className="empty-state">Cargando…</div>
        ) : keywordOverrides.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 10 }}>
            Todavía no guardaste ninguna. Empieza por los productos que Mercado Libre categorizó mal.
          </div>
        ) : (
          <>
          <table style={{ marginBottom: 12 }}>
            <thead>
              <tr>
                <th>Palabra clave</th>
                <th>Categoría guardada</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pageKeywordOverrides!.map((o) => (
                <tr key={o.id}>
                  <td>{o.keyword}</td>
                  <td>
                    {o.categoryName} ({o.categoryId})
                  </td>
                  <td>
                    <button className="secondary small" onClick={() => removeOverride(o.id)}>
                      Quitar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={keywordOverridesPg.page} totalPages={keywordOverridesPg.totalPages} totalItems={keywordOverrides.length} pageSize={keywordOverridesPg.pageSize} onChange={keywordOverridesPg.setPage} />
          </>
        )}

        <div className="form-row" style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div>
            <label>Palabra clave</label>
            <input
              placeholder='Ej. "bandana"'
              value={newOverrideKeyword}
              onChange={(e) => setNewOverrideKeyword(e.target.value)}
            />
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label>Buscar la categoría real en Mercado Libre</label>
            <input
              placeholder="Texto para buscar categorías"
              value={categorySearchQuery}
              onChange={(e) => setCategorySearchQuery(e.target.value)}
            />
          </div>
          <button
            className="secondary"
            disabled={categorySearchBusy || !categorySearchQuery.trim()}
            onClick={searchCategoriesForOverride}
          >
            {categorySearchBusy ? "Buscando…" : "Buscar"}
          </button>
        </div>

        {categorySearchResults && (
          <div style={{ marginTop: 10 }}>
            {categorySearchResults.length === 0 ? (
              <div className="empty-state">Mercado Libre no encontró ninguna categoría para ese texto.</div>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
                {categorySearchResults.map((c) => (
                  <li
                    key={c.categoryId}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "6px 0",
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    <span>
                      <div>
                        {c.categoryName} ({c.categoryId})
                      </div>
                      {/* Pedido real del usuario: "Cascos" (y varios otros nombres) se
                          repite en ramas del árbol de Mercado Libre totalmente distintas
                          (bicicleta, construcción, trabajo...) — sin el camino completo
                          no hay forma de saber cuál es cuál solo por el nombre. */}
                      <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                        {c.categoryPath && c.categoryPath.length > 0
                          ? c.categoryPath.join(" › ")
                          : "No se pudo traer el camino completo de esta categoría."}
                      </div>
                    </span>
                    <button className="small" disabled={overrideSaveBusy} onClick={() => saveOverride(c)}>
                      Usar esta categoría
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="card">
        {groups === null ? (
          <div className="empty-state">Cargando…</div>
        ) : groups.length === 0 ? (
          <div className="empty-state">No hay productos de Shopify pendientes de publicar en Mercado Libre. 🎉</div>
        ) : (
          <>
          <table>
            <thead>
              <tr>
                <th>Grupo (categoría de Shopify)</th>
                <th>Productos</th>
                <th>Categoría en Mercado Libre</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pageGroups!.map((g) => (
                <Fragment key={g.groupKey}>
                  <tr>
                    <td>
                      {/* Cuando un producto de Shopify no tiene categoría asignada, el
                          "grupo" es ese producto solo y groupKey queda como "sku:<SKU>"
                          — sin el nombre al lado no había forma de reconocer de qué
                          producto se trataba para elegir bien la categoría. */}
                      {g.groupKey.startsWith("sku:") ? (
                        <>
                          <div>{g.sampleProductName}</div>
                          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                            SKU: {g.groupKey.slice(4)}
                          </div>
                        </>
                      ) : (
                        <>
                          <div>{g.groupKey}</div>
                          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                            Ej.: {g.sampleProductName}
                          </div>
                        </>
                      )}
                    </td>
                    <td>{g.productCount}</td>
                    <td>
                      {g.confirmed ? (
                        <span className="badge badge-sincronizado">{g.categoryName}</span>
                      ) : (
                        <span className="badge badge-pendiente">Sin confirmar</span>
                      )}
                    </td>
                    <td>
                      {g.confirmed ? (
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <div>
                            <input
                              style={{ width: 55 }}
                              type="number"
                              min={1}
                              max={g.productCount}
                              value={batchLimits[g.groupKey] ?? g.productCount}
                              onChange={(e) =>
                                setBatchLimits((prev) => ({ ...prev, [g.groupKey]: Number(e.target.value) }))
                              }
                            />
                            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                              de {g.productCount} en Shopify
                            </div>
                          </div>
                          <button
                            className="small"
                            disabled={busy || autoBusy}
                            onClick={() => runBatch(g.groupKey, g.productCount)}
                            title="El stock de cada producto se toma automático desde Shopify — esta cantidad es solo cuántos productos distintos publicar en este clic."
                          >
                            Publicar lote
                          </button>
                          <RowActionsMenu
                            actions={[
                              {
                                label: "Cambiar categoría",
                                onClick: () => openGroup(g.groupKey),
                                disabled: busy || autoBusy,
                              },
                            ]}
                          />
                        </div>
                      ) : (
                        <button className="small" disabled={busy || autoBusy} onClick={() => openGroup(g.groupKey)}>
                          {busy && selectedGroup === g.groupKey ? "Consultando…" : "Revisar categoría"}
                        </button>
                      )}
                    </td>
                  </tr>
                  {batchResults[g.groupKey] && (
                    <tr>
                      <td colSpan={4} style={{ fontSize: 12.5, color: "var(--text-dim)" }}>
                        Último lote: {batchResults[g.groupKey]!.created} creados de{" "}
                        {batchResults[g.groupKey]!.attempted} intentados.
                        {batchResults[g.groupKey]!.errors.length > 0 && (
                          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                            {batchResults[g.groupKey]!.errors.map((e, i) => (
                              <li key={i}>
                                {e.productName} ({e.sku}): {e.reason}
                              </li>
                            ))}
                          </ul>
                        )}
                        {batchResults[g.groupKey]!.warnings.length > 0 && (
                          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                            {batchResults[g.groupKey]!.warnings.map((w, i) => (
                              <li key={i}>
                                ⚠ {w.productName} ({w.sku}): {w.reason}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          <Pagination page={groupsPg.page} totalPages={groupsPg.totalPages} totalItems={groups.length} pageSize={groupsPg.pageSize} onChange={groupsPg.setPage} />
          </>
        )}
      </div>

      {selectedGroup && (
        <div className="card" ref={panelRef}>
          <h2>
            Confirmar categoría —{" "}
            {selectedGroup.startsWith("sku:")
              ? `${groups?.find((g) => g.groupKey === selectedGroup)?.sampleProductName ?? ""} (SKU: ${selectedGroup.slice(4)})`
              : selectedGroup}
          </h2>
          {!selectedGroup.startsWith("sku:") && (
            <p style={{ fontSize: 12.5, color: "var(--text-dim)", marginTop: -6 }}>
              Ejemplo de producto en este grupo: {groups?.find((g) => g.groupKey === selectedGroup)?.sampleProductName}
            </p>
          )}

          {busy && !preview ? (
            <div className="empty-state">Consultando Mercado Libre…</div>
          ) : preview ? (
            <>
              <div className="form-row">
                <label>Categoría predicha</label>
                <select
                  value={chosenCategory?.categoryId ?? ""}
                  onChange={(e) => {
                    const found = preview.predictions.find((p) => p.categoryId === e.target.value);
                    if (found) setChosenCategory(found);
                  }}
                >
                  {preview.predictions.map((p) => (
                    <option key={p.categoryId} value={p.categoryId}>
                      {p.categoryName} ({p.categoryId})
                      {p.categoryPath && p.categoryPath.length > 1
                        ? ` — ${p.categoryPath.slice(0, -1).join(" › ")}`
                        : ""}
                    </option>
                  ))}
                </select>
                {/* Pedido real del usuario: "Cascos" (y varios otros nombres) se
                    repite en ramas del árbol de Mercado Libre totalmente distintas
                    (bicicleta, construcción, trabajo...) — se muestra el camino
                    completo de la categoría elegida bien visible, no solo metido
                    en el texto chico de cada opción del selector de arriba. */}
                {chosenCategory?.categoryPath && chosenCategory.categoryPath.length > 0 && (
                  <div style={{ fontSize: 12.5, color: "var(--accent)", marginTop: 4 }}>
                    📍 {chosenCategory.categoryPath.join(" › ")}
                  </div>
                )}
                <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 4 }}>
                  {preview.categorySource === "keyword_override"
                    ? "✓ Esta categoría salió de una palabra clave que ya guardaste — verificada a mano."
                    : "⚠ Esta categoría es solo la predicción de texto de Mercado Libre, todavía sin verificar — revísala antes de confirmar (si corresponde a un producto que se repite, conviene guardarla como palabra clave abajo)."}
                </div>
              </div>

              {preview.groupNeeds.requiresSizeGuide && (
                <div
                  className="error-banner"
                  style={{ marginBottom: 12 }}
                >
                  Esta categoría exige una "guía de talles" (tramo obligatorio de Mercado Libre para
                  algunas categorías de moda) que esta app todavía no sabe crear — si confirmas este
                  mapeo, Mercado Libre va a rechazar cada publicación de este grupo con un error de
                  atributo faltante (<code>SIZE_GRID_ID</code>). Busca otra categoría más abajo que no
                  sea de "Ropa" (por ejemplo, "accesorios" o "equipamiento" en vez de "chaleco" a
                  secas) antes de confirmar.
                </div>
              )}

              <div className="form-row" style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                <div style={{ flex: 1 }}>
                  <label>Buscar otra categoría</label>
                  <input
                    placeholder="Texto para volver a predecir la categoría"
                    value={customQuery}
                    onChange={(e) => setCustomQuery(e.target.value)}
                  />
                </div>
                <button className="secondary" disabled={busy || autoBusy || !customQuery.trim()} onClick={searchOtherCategory}>
                  Buscar
                </button>
              </div>

              <div className="form-row">
                <label>Tipo de publicación</label>
                <select value={chosenListingTypeId} onChange={(e) => setChosenListingTypeId(e.target.value)}>
                  {(listingTypes ?? []).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.id})
                    </option>
                  ))}
                </select>
              </div>

              {preview.groupNeeds.needsGroupDefault.map((attr) =>
                attr.values.length > 0 ? (
                  <div className="form-row" key={attr.id}>
                    <label>
                      {attr.name}
                      <InfoDisclosure>
                        {attr.required
                          ? "Requerido por esta categoría."
                          : "Opcional — se completa solo desde Shopify si está disponible."}
                      </InfoDisclosure>
                    </label>
                    <select
                      value={attributeAnswers[attr.id]?.valueId ?? ""}
                      onChange={(e) => setAttributeAnswer(attr, e.target.value)}
                    >
                      <option value="">— Elegir —</option>
                      {attr.values.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div className="form-row" key={attr.id}>
                    <label>
                      {attr.name}
                      <InfoDisclosure>
                        {attr.required
                          ? "Requerido por esta categoría — texto libre, se usa igual para todos los productos del grupo."
                          : "Opcional — se completa solo con el dato de Shopify de cada producto; dejar en blanco para eso."}
                      </InfoDisclosure>
                    </label>
                    <input
                      placeholder={`Valor para "${attr.name}"`}
                      value={attributeAnswers[attr.id]?.valueName ?? ""}
                      onChange={(e) => setFreeTextAnswer(attr.id, e.target.value)}
                    />
                  </div>
                ),
              )}

              {preview.groupNeeds.gtinFallback && (
                <div className="form-row">
                  <label>
                    Esta categoría exige GTIN — para productos sin código de barras propio, ¿qué se
                    declara?
                  </label>
                  <select value={gtinAnswerValueId} onChange={(e) => setGtinAnswerValueId(e.target.value)}>
                    <option value="">— Elegir —</option>
                    {preview.groupNeeds.gtinFallback.values.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {preview.groupNeeds.hasSizeAttribute && (
                <div className="form-row">
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: "normal" }}>
                    <input
                      type="checkbox"
                      checked={forceStandardSize}
                      onChange={(e) => setForceStandardSize(e.target.checked)}
                    />
                    Talla: usar siempre "Standard" para todos los productos de este grupo (ignora la
                    talla que traiga Shopify) — para productos ajustables de una sola talla, como
                    chalecos tácticos.
                  </label>
                </div>
              )}

              {preview.groupNeeds.colorRequired && (
                <div className="form-row">
                  <label>
                    Color por defecto (opcional) — se usa solo para productos de este grupo que NO
                    tengan color cargado en Shopify. Esta categoría exige color; un producto sin
                    color propio y sin este default queda como error al publicar en vez de crear
                    una publicación incompleta (caso real: "BARRIGUERA CON CINTURON").
                  </label>
                  <select value={defaultColorValueId} onChange={(e) => setDefaultColorValueId(e.target.value)}>
                    <option value="">— Sin default —</option>
                    {preview.groupNeeds.colorValues.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div style={{ display: "flex", gap: 10 }}>
                <button disabled={busy || autoBusy || !chosenCategory} onClick={confirmMapping}>
                  Confirmar mapeo de esta categoría
                </button>
                <button className="secondary" disabled={busy || autoBusy} onClick={() => setSelectedGroup(null)}>
                  Cancelar
                </button>
              </div>
            </>
          ) : (
            <div className="empty-state">No se encontró ninguna categoría para este grupo.</div>
          )}
        </div>
      )}
    </div>
  );
}
