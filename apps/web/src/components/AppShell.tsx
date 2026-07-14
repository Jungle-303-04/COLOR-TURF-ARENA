import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";

export const BrandMark = () => (
  <span className="brand-mark" aria-label="Color Turf Arena Ops">
    <i className="brand-dot brand-dot-a" />
    <i className="brand-dot brand-dot-b" />
    <span>COLOR TURF <b>ARENA</b></span>
  </span>
);

export const AppShell = ({ title, eyebrow, actions, children }: {
  title: string;
  eyebrow: string;
  actions?: ReactNode;
  children: ReactNode;
}) => (
  <div className="app-shell">
    <header className="topbar">
      <BrandMark />
      <nav aria-label="운영 메뉴">
        <NavLink to="/admin">CONTROL</NavLink>
        <NavLink to="/ops">OPS LIVE</NavLink>
      </nav>
      <div className="topbar-actions">{actions}</div>
    </header>
    <main className="shell-main">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
        </div>
      </div>
      {children}
    </main>
  </div>
);
