import { Navigate, Route, Routes } from "react-router-dom";
import { JoinPage } from "./pages/JoinPage";
import { AdminPage } from "./pages/AdminPage";
import { OpsPage } from "./pages/OpsPage";
import { ScreenPage } from "./pages/ScreenPage";

export const App = () => (
  <Routes>
    <Route path="/" element={<Navigate to="/ops" replace />} />
    <Route path="/admin" element={<AdminPage />} />
    <Route path="/ops" element={<OpsPage />} />
    <Route path="/watch/:roomCode" element={<ScreenPage />} />
    <Route path="/play/:roomCode" element={<JoinPage />} />
    <Route path="/screen/:roomCode" element={<ScreenPage />} />
    <Route path="/join/:roomCode" element={<JoinPage />} />
    <Route path="*" element={<Navigate to="/ops" replace />} />
  </Routes>
);
