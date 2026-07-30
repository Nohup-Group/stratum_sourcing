import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { getKey } from "./api";
import Layout from "./components/Layout";
import CompaniesPage from "./pages/CompaniesPage";
import CompanyPage from "./pages/CompanyPage";
import LoginPage from "./pages/LoginPage";
import PicksPage from "./pages/PicksPage";
import PipelinePage from "./pages/PipelinePage";
import SignalsPage from "./pages/SignalsPage";
import SourcesPage from "./pages/SourcesPage";
import SourcingMapPage from "./pages/SourcingMapPage";

function RequireKey({ children }: { children: JSX.Element }) {
  const location = useLocation();
  if (!getKey()) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireKey>
            <Layout />
          </RequireKey>
        }
      >
        <Route path="/" element={<PicksPage />} />
        <Route path="/map" element={<SourcingMapPage />} />
        <Route path="/picks" element={<Navigate to="/" replace />} />
        {/* operator view: still reachable, but off the demo nav */}
        <Route path="/pipeline" element={<PipelinePage />} />
        <Route path="/companies" element={<CompaniesPage />} />
        <Route path="/companies/:id" element={<CompanyPage />} />
        <Route path="/signals" element={<SignalsPage />} />
        <Route path="/sources" element={<SourcesPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
