import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { clearKey } from "../api";

const NAV = [
  { to: "/", label: "Pipeline", end: true },
  { to: "/picks", label: "Top picks" },
  { to: "/companies", label: "Companies" },
  { to: "/signals", label: "Signal library" },
  { to: "/sources", label: "Sources" },
];

export default function Layout() {
  const navigate = useNavigate();
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          Stratum<sup>3</sup>
        </div>
        <div className="brand-sub">Sourcing console</div>
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}
          >
            {item.label}
          </NavLink>
        ))}
        <div className="sidebar-foot">
          Powered by Nohup ·{" "}
          <button
            onClick={() => {
              clearKey();
              navigate("/login");
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
