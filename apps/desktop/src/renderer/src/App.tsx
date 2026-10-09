import { NavLink, Route, Routes } from "react-router-dom";
import DashboardPage from "./pages/DashboardPage";
import ProductosPage from "./pages/ProductosPage";
import CrearProductoPage from "./pages/CrearProductoPage";
import VentasPage from "./pages/VentasPage";
import PublicarMeliPage from "./pages/PublicarMeliPage";
import EstadoMeliPage from "./pages/EstadoMeliPage";
import ConciliacionPage from "./pages/ConciliacionPage";
import ConfiguracionPage from "./pages/ConfiguracionPage";
import AuditoriaPage from "./pages/AuditoriaPage";
import AuditoriaStockPage from "./pages/AuditoriaStockPage";
import DescuentosPage from "./pages/DescuentosPage";
import PromocionesMeliPage from "./pages/PromocionesMeliPage";
import DespachosPage from "./pages/DespachosPage";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/productos", label: "Productos" },
  { to: "/descuentos", label: "Descuentos" },
  { to: "/promociones-meli", label: "Promociones ML" },
  { to: "/crear-producto", label: "Crear producto" },
  { to: "/ventas", label: "Venta presencial" },
  { to: "/despachos", label: "Despachos" },
  { to: "/publicar-meli", label: "Publicar en ML" },
  { to: "/estado-meli", label: "Estado en ML" },
  { to: "/conciliacion", label: "Conciliación" },
  { to: "/auditoria", label: "Auditoría" },
  { to: "/auditoria-stock", label: "Auditoría de Stock" },
  { to: "/configuracion", label: "Configuración" },
];

export default function App() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">BS</span>
          <div>
            <div className="brand-title">BLACK SAND</div>
            <div className="brand-subtitle">Manager · Fase 2b</div>
          </div>
        </div>
        <nav>
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => "nav-link" + (isActive ? " active" : "")}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="phase-badge">Publicar en Mercado Libre</span>
          <p>Publica productos de Shopify en Mercado Libre para que el catálogo quede emparejado por SKU (Fase 2b).</p>
        </div>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/productos" element={<ProductosPage />} />
          <Route path="/descuentos" element={<DescuentosPage />} />
          <Route path="/promociones-meli" element={<PromocionesMeliPage />} />
          <Route path="/crear-producto" element={<CrearProductoPage />} />
          <Route path="/ventas" element={<VentasPage />} />
          <Route path="/despachos" element={<DespachosPage />} />
          <Route path="/publicar-meli" element={<PublicarMeliPage />} />
          <Route path="/estado-meli" element={<EstadoMeliPage />} />
          <Route path="/conciliacion" element={<ConciliacionPage />} />
          <Route path="/auditoria" element={<AuditoriaPage />} />
          <Route path="/auditoria-stock" element={<AuditoriaStockPage />} />
          <Route path="/configuracion" element={<ConfiguracionPage />} />
        </Routes>
      </main>
    </div>
  );
}
