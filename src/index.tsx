import ReactDOM from "react-dom/client";
import { ApiProvider } from "@reduxjs/toolkit/query/react";
import App from "./App";
import { pokemonApi } from "./services/pokemon";
// import { pokemonApi } from "./services/pokemon-fix";
// uncomment the above line and comment the one above to see the fix in action

const rootElement = document.getElementById("root");

const reactRoot = ReactDOM.createRoot(rootElement as HTMLElement);

reactRoot.render(
  <ApiProvider api={pokemonApi}>
    <App />
  </ApiProvider>,
);
