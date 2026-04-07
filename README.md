# break-rtk

This repository exists to reproduce a `RangeError: Maximum call stack size exceeded` failure in RTK Query when a store contains a large number of `createApi` middlewares.

The default app configuration is intentionally broken. It creates enough RTK Query API slices to trigger a recursive middleware self-registration cascade on the first dispatched query action.

The repository also includes a mitigation middleware that flattens that cascade so the same initialization sequence completes without overflowing the JavaScript call stack.

## What this app demonstrates

- How RTK Query middleware self-registration scales poorly when many API slices are mounted in the same store.
- Why the failure shows up as a query that never completes successfully.
- How a queueing middleware can flatten the initialization cascade from `O(N^2)` to `O(N)`.

## Project map

- `src/services/pokemon.ts`: broken reproduction path with many RTK Query middlewares and no cascade flattener.
- `src/services/pokemon-fix.ts`: mitigation path with the flattener prepended before the RTK Query middleware chain.
- `src/rtkMiddlewareFlattener.ts`: middleware that queues nested `middlewareRegistered` actions and flushes them after the outer dispatch completes.
- `src/index.tsx`: `ApiProvider` wiring. This file controls which `pokemonApi` instance the app uses.
- `src/Pokemon.tsx`: query hook usage. This file also has to point at the same service module when switching between the broken and fixed paths.

## Install and run

This repo uses the existing Create React App scripts in `package.json`.

```bash
npm ci
npm start
```

After the dev server starts, open the local URL shown in the terminal, usually `http://localhost:3000`.

## Reproduce the bug

The default repo state reproduces the failure.

1. Install dependencies.
2. Start the app with `npm start`.
3. Open the page in the browser.
4. Wait for the initial RTK Query request to run.
5. Open the browser devtools console.

Expected result in the broken mode:

- The console shows `RangeError: Maximum call stack size exceeded`.
- The query does not complete successfully.
- The UI may stay in a loading or empty-data state because the RTK Query registration flow never finishes correctly.

Console excerpt:

```text
redux-thunk.mjs:12 Uncaught RangeError: Maximum call stack size exceeded
    at Module.isAction (redux-thunk.mjs:12:1)
    at index.ts:51:1
    at index.ts:67:1
    at index.ts:67:1
    at index.ts:67:1
    at redux-thunk.mjs:7:1
    at actionCreatorInvariantMiddleware.ts:29:1
    at Object.dispatch (applyMiddleware.ts:52:1)
    at index.ts:57:1
    at index.ts:67:1
    ... many repeated nested middleware frames continue ...
```

## Why the bug happens

Every RTK Query API created with `createApi` contributes its own reducer state and its own middleware.

RTK Query also keeps a `config` slice per API. That slice tracks whether the middleware for that API has registered with the store by updating `middlewareRegistered` from `false` to `true`.

Relevant upstream implementation details:

- Config slice setup: <https://github.com/reduxjs/redux-toolkit/blob/v2.11.2/packages/toolkit/src/query/core/buildSlice.ts#L676>
- Middleware self-registration: <https://github.com/reduxjs/redux-toolkit/blob/v2.11.2/packages/toolkit/src/query/core/buildMiddleware/index.ts#L69>

The important behavior is this:

1. Each RTK Query middleware instance has its own `initialized` closure flag.
2. On the first action that middleware sees, it sets `initialized = true`.
3. It then dispatches its own internal `middlewareRegistered` action.
4. That dispatch uses `mwApi.dispatch`, which is the full store dispatch, not `next`.
5. Because it re-enters the full chain from the top, the next uninitialized RTK Query middleware does the same thing.

With a large number of API slices, the first action creates a nested cascade:

```text
dispatch(action A)
  -> MW1 sees first action
    -> dispatch(middlewareRegistered1)
      -> full chain restarts
        -> MW2 sees first action
          -> dispatch(middlewareRegistered2)
            -> full chain restarts
              -> MW3 sees first action
                -> dispatch(middlewareRegistered3)
                  -> ... repeats for many middlewares ...
```

This is a scaling problem, not a single bad middleware invocation. Each new nested dispatch traverses all previously initialized middlewares before it reaches the next uninitialized one. That means the amount of work and call-stack depth grows roughly quadratically, $O(N^2)$, as more API middlewares are added.

In this repo, the broken implementation in `src/services/pokemon.ts` creates enough API slices to push the browser over its stack limit.

### Why the failure is easy to misread

The visible error is thrown inside the middleware cascade, but the first user-facing dispatch is a query thunk.

That matters because thunk-related work adds more stack frames:

- the thunk middleware unwraps the function action
- `createAsyncThunk` dispatches `pending`
- the nested RTK Query middleware cascade runs during that dispatch
- when the stack overflows, the error is caught inside the thunk flow and turned into a rejected action path

The result is a confusing failure mode:

- `middlewareRegistered` never reaches the reducer for the affected API slice
- RTK Query still sees `config.middlewareRegistered === false`
- the query entry is never established correctly
- the component appears stuck in loading or without data

## Reproduce the fix

The fix already exists in this repo, but the repo does not currently have a single toggle point. To switch the app to the mitigation path, update both imports below.

In `src/index.tsx`, replace:

```ts
import { pokemonApi } from "./services/pokemon";
// import { pokemonApi } from "./services/pokemon-fix";
```

with:

```ts
// import { pokemonApi } from "./services/pokemon";
import { pokemonApi } from "./services/pokemon-fix";
```

In `src/Pokemon.tsx`, replace:

```ts
import { useGetPokemonByNameQuery } from "./services/pokemon";
```

with:

```ts
import { useGetPokemonByNameQuery } from "./services/pokemon-fix";
```

Then restart the app if needed and reload the page.

Expected result in the fixed mode:

- No `Maximum call stack size exceeded` error during initialization.
- The Pokemon data renders successfully.
- The fixed path remains stable even though `src/services/pokemon-fix.ts` creates more API slices than the broken example.

## Why the fix works

The mitigation lives in `src/rtkMiddlewareFlattener.ts` and is prepended in `src/services/pokemon-fix.ts`.

Its strategy is simple:

1. Track whether a dispatch is already in progress.
2. If a nested RTK Query `middlewareRegistered` action appears during that dispatch, queue it instead of dispatching it recursively.
3. Let the outermost action finish traversing the middleware chain and reach the reducer.
4. Flush the queued `middlewareRegistered` actions one by one after the outer dispatch completes.

That changes the shape of the initialization sequence.

Before the mitigation:

```text
dispatch(initiate())
  -> thunk
    -> dispatch(pending)
      -> MW1 dispatches middlewareRegistered1
        -> MW2 dispatches middlewareRegistered2
          -> MW3 dispatches middlewareRegistered3
            -> ... deeply nested recursion ...
```

After the mitigation:

```text
dispatch(initiate())
  -> flattener sees outer dispatch
    -> thunk
      -> dispatch(pending)
        -> MW1 queues middlewareRegistered1
        -> MW2 queues middlewareRegistered2
        -> MW3 queues middlewareRegistered3
        -> ... outer action completes ...
  -> flattener flushes queued actions sequentially
```

This works because RTK Query sets `initialized = true` before it dispatches `middlewareRegistered`.

So when the flattener queues that internal action instead of letting it recurse immediately:

- the middleware is already marked initialized
- later queued `middlewareRegistered` actions do not trigger a fresh cascade
- the queued actions can safely be replayed one at a time

That reduces the stack-growth pattern from roughly $O(N^2)$ nesting to $O(N)$ sequential processing.

### Why placement matters

The flattener must run before thunk and before the RTK Query middleware chain.

In `src/services/pokemon-fix.ts`, it is added with `.prepend(rtkQueryInitCascadeFlattener)`. That placement matters because RTK Query uses `mwApi.dispatch`, which re-enters the full composed store dispatch. The flattener must be at the front of that composed dispatch pipeline so it can intercept nested `middlewareRegistered` actions before they recurse through the rest of the chain.

## Notes

- The broken example uses about 100 RTK Query API slices to reproduce the overflow.
- The fixed example uses 1000 API slices to demonstrate that flattening the cascade scales beyond the original failure point.
- This repository documents a mitigation strategy for a high-middleware-count test or repro environment. It is not an upstream RTK Query patch.
