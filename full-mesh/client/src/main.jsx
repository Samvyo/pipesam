import React from "react";
import ReactDOM from "react-dom/client";
import { RoomProvider } from "./rtc/RoomContext.jsx";
import App from "./App.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <RoomProvider>
      <App />
    </RoomProvider>
  </React.StrictMode>
);