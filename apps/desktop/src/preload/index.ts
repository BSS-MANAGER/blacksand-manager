import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../shared-ipc-types.js";
import type {
  BlacksandApi,
  CreateProductInput,
  DiscountApplyInput,
  MercadoLibreConfigInput,
  MeliConfirmGroupMappingInput,
  MeliSkuFixItemInput,
  PosSaleInput,
  ProductUpdateInput,
  ShopifyConfigInput,
} from "../shared-ipc-types.js";

/**
 * Puente de contexto (contextIsolation: true, nodeIntegration: false): el
 * renderer NUNCA tiene acceso directo a Node/Electron ni a la bóveda de
 * credenciales — solo puede invocar estas funciones explícitas vía IPC.
 */
const api: BlacksandApi = {
  dashboard: {
    getSyncStatus: () => ipcRenderer.invoke(IPC_CHANNELS.dashboardGetSyncStatus),
  },
  channels: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.channelsGetStatus),
    saveShopifyConfig: (input: ShopifyConfigInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.channelsSaveShopifyConfig, input),
    saveMercadoLibreConfig: (input: MercadoLibreConfigInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.channelsSaveMercadoLibreConfig, input),
    startMercadoLibreOAuth: () => ipcRenderer.invoke(IPC_CHANNELS.channelsStartMercadoLibreOAuth),
    completeMercadoLibreOAuth: (pastedUrlOrCode: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.channelsCompleteMercadoLibreOAuth, pastedUrlOrCode),
    getMeliPublishDefaults: () => ipcRenderer.invoke(IPC_CHANNELS.channelsGetMeliPublishDefaults),
    saveMeliPublishDefaults: (input: { defaultBrand: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.channelsSaveMeliPublishDefaults, input),
  },
  products: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.productsList),
    update: (input: ProductUpdateInput) => ipcRenderer.invoke(IPC_CHANNELS.productsUpdate, input),
    pickImages: () => ipcRenderer.invoke(IPC_CHANNELS.productsPickImages),
    createAndPublish: (input: CreateProductInput) => ipcRenderer.invoke(IPC_CHANNELS.productsCreateAndPublish, input),
    delete: (productId: string, force?: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.productsDelete, productId, force),
  },
  reconciliation: {
    listPending: () => ipcRenderer.invoke(IPC_CHANNELS.reconciliationListPending),
    confirmMatch: (mapId: string, centralVariantId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.reconciliationConfirmMatch, mapId, centralVariantId),
    ignore: (mapId: string) => ipcRenderer.invoke(IPC_CHANNELS.reconciliationIgnore, mapId),
  },
  audit: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.auditList),
  },
  sync: {
    runImportNow: (channel: "shopify" | "mercadolibre") =>
      ipcRenderer.invoke(IPC_CHANNELS.syncRunImportNow, channel),
    runOrderPollNow: (customLookbackHours?: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.syncRunOrderPollNow, customLookbackHours),
  },
  orders: {
    listRecent: () => ipcRenderer.invoke(IPC_CHANNELS.ordersListRecent),
    listPendingCancellations: () => ipcRenderer.invoke(IPC_CHANNELS.ordersListPendingCancellations),
    resolveCancellation: (orderId: string, restocked: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.ordersResolveCancellation, orderId, restocked),
    backfillOrderNumbers: () => ipcRenderer.invoke(IPC_CHANNELS.ordersBackfillOrderNumbers),
    retrySync: (orderId: string) => ipcRenderer.invoke(IPC_CHANNELS.ordersRetrySync, orderId),
  },
  pos: {
    registerSale: (input: PosSaleInput) => ipcRenderer.invoke(IPC_CHANNELS.posRegisterSale, input),
  },
  meliPublish: {
    listCandidateGroups: () => ipcRenderer.invoke(IPC_CHANNELS.meliPublishListCandidateGroups),
    previewCategory: (groupKey: string, customQuery?: string, includeAllPaths?: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.meliPublishPreviewCategory, groupKey, customQuery, includeAllPaths),
    confirmGroupMapping: (input: MeliConfirmGroupMappingInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.meliPublishConfirmGroupMapping, input),
    runBatch: (groupKey: string, limit: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.meliPublishRunBatch, groupKey, limit),
    getListingTypes: () => ipcRenderer.invoke(IPC_CHANNELS.meliGetListingTypes),
    syncDescriptions: () => ipcRenderer.invoke(IPC_CHANNELS.meliSyncDescriptions),
    listKeywordOverrides: () => ipcRenderer.invoke(IPC_CHANNELS.meliPublishListKeywordOverrides),
    saveKeywordOverride: (input: { keyword: string; categoryId: string; categoryName: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.meliPublishSaveKeywordOverride, input),
    deleteKeywordOverride: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.meliPublishDeleteKeywordOverride, id),
    searchCategories: (query: string) => ipcRenderer.invoke(IPC_CHANNELS.meliPublishSearchCategories, query),
    previewAllPendingCategories: () => ipcRenderer.invoke(IPC_CHANNELS.meliPublishPreviewAllPendingCategories),
  },
  meliListing: {
    listIssues: () => ipcRenderer.invoke(IPC_CHANNELS.meliListingListIssues),
    reactivate: (channelProductId: string) => ipcRenderer.invoke(IPC_CHANNELS.meliListingReactivate, channelProductId),
    close: (channelProductId: string) => ipcRenderer.invoke(IPC_CHANNELS.meliListingClose, channelProductId),
  },
  meliDuplicateFix: {
    preview: () => ipcRenderer.invoke(IPC_CHANNELS.meliDuplicateFixPreview),
    close: (channelProductIds: string[]) => ipcRenderer.invoke(IPC_CHANNELS.meliDuplicateFixClose, channelProductIds),
  },
  meliBrandFix: {
    preview: (skuPrefix: string) => ipcRenderer.invoke(IPC_CHANNELS.meliBrandFixPreview, skuPrefix),
    run: (skuPrefix: string, newBrand: string, updateLocalBrand: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.meliBrandFixRun, skuPrefix, newBrand, updateLocalBrand),
  },
  meliSkuPrefixBrand: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.meliSkuPrefixBrandList),
    save: (input: { skuPrefix: string; brand: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.meliSkuPrefixBrandSave, input),
    delete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.meliSkuPrefixBrandDelete, id),
  },
  meliSkuFix: {
    preview: () => ipcRenderer.invoke(IPC_CHANNELS.meliSkuFixPreview),
    run: (items: MeliSkuFixItemInput[]) => ipcRenderer.invoke(IPC_CHANNELS.meliSkuFixRun, items),
  },
  stockAudit: {
    preview: () => ipcRenderer.invoke(IPC_CHANNELS.stockAuditPreview),
    apply: (variantId: string, quantity: number) => ipcRenderer.invoke(IPC_CHANNELS.stockAuditApply, variantId, quantity),
  },
  discount: {
    preview: () => ipcRenderer.invoke(IPC_CHANNELS.discountPreview),
    apply: (input: DiscountApplyInput) => ipcRenderer.invoke(IPC_CHANNELS.discountApply, input),
    listBatches: () => ipcRenderer.invoke(IPC_CHANNELS.discountListBatches),
    listBaselines: () => ipcRenderer.invoke(IPC_CHANNELS.discountListBaselines),
    revert: (batchId: string) => ipcRenderer.invoke(IPC_CHANNELS.discountRevert, batchId),
  },
  shipping: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.shippingGetStatus),
    saveGoogleClient: (input: { clientId: string; clientSecret: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.shippingSaveGoogleClient, input),
    connectGmail: () => ipcRenderer.invoke(IPC_CHANNELS.shippingConnectGmail),
    disconnectGmail: () => ipcRenderer.invoke(IPC_CHANNELS.shippingDisconnectGmail),
    sync: () => ipcRenderer.invoke(IPC_CHANNELS.shippingSync),
    getMonth: (year: number, month: number) => ipcRenderer.invoke(IPC_CHANNELS.shippingGetMonth, year, month),
    setDayOverride: (day: string, dispatched: boolean | null, note?: string | null) =>
      ipcRenderer.invoke(IPC_CHANNELS.shippingSetDayOverride, day, dispatched, note),
    setDailyRate: (rate: number) => ipcRenderer.invoke(IPC_CHANNELS.shippingSetDailyRate, rate),
  },
  cloudWorker: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.cloudWorkerStatus),
  },
  meliPromotions: {
    probe: () => ipcRenderer.invoke(IPC_CHANNELS.meliPromotionsProbe),
  },
};

contextBridge.exposeInMainWorld("blacksand", api);
