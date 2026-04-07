import {
  combineReducers,
  configureStore,
  UnknownAction,
} from "@reduxjs/toolkit";
import {
  createApi,
  fetchBaseQuery,
  setupListeners,
} from "@reduxjs/toolkit/query/react";

export const pokemonApi = createApi({
  reducerPath: "pokemonApi",
  baseQuery: fetchBaseQuery({ baseUrl: "https://pokeapi.co/api/v2/" }),
  tagTypes: [],
  endpoints: (builder) => ({
    getPokemonByName: builder.query({
      query: (name: string) => `pokemon/${name}`,
    }),
  }),
});

const apiModules = [pokemonApi];

for (let i = 0; i < 100; i++) {
  apiModules.push(
    createApi({
      reducerPath: "pokemonApi",
      baseQuery: fetchBaseQuery({ baseUrl: `https://pokeapi.co/api/v2/${i}/` }),
      tagTypes: [],
      endpoints: (builder) => ({
        getPokemonByName: builder.query({
          query: (name: string) => `pokemon/${name}`,
        }),
      }),
    }),
  );
}

const apiModuleReducers = apiModules.reduce(
  (acc, apiModule) => {
    acc[apiModule.reducerPath] = apiModule.reducer;
    return acc;
  },
  {} as Record<string, any>,
);
const apiMiddleware = apiModules.map((apiModule) => {
  return apiModule.middleware as any;
});

const reducer = combineReducers(apiModuleReducers);

const rootReducer = (state: any, action: UnknownAction) => {
  const updatedState = reducer(state, action);

  apiModules.forEach((apiModule) => {
    Object.defineProperty(updatedState, apiModule.reducerPath, {
      get() {
        if ("get" in this && typeof this.get === "function") {
          return this.get(apiModule.reducerPath);
        }
      },
      // prevents errors when the no state changes happen and nextState === prevState so this is already defined
      configurable: true,
    });
  });

  return updatedState;
};

const store = configureStore({
  reducer: rootReducer,

  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      thunk: true,
      immutableCheck: false,
      serializableCheck: false,
    }).concat(apiMiddleware),
});

setupListeners(store.dispatch);

// Export hooks for usage in functional components
export const { useGetPokemonByNameQuery } = pokemonApi;
