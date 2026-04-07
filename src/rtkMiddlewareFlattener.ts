import type { Middleware, UnknownAction } from "@reduxjs/toolkit";

/**
 * Middleware that flattens the RTK Query middleware initialization cascade.
 *
 * Problem: With 90+ RTK Query API slices, each middleware dispatches a
 * `middlewareRegistered` action on its first action. These dispatches nest
 * recursively (O(N²) call stack depth) because each `middlewareRegistered`
 * action triggers the next uninitialized middleware. This exceeds the V8 stack
 * limit, causing a silent RangeError that prevents the actions from reaching
 * the reducer.
 *
 * Solution: This middleware detects when a `middlewareRegistered` action is
 * dispatched during another dispatch (i.e., inside the cascade) and queues
 * it instead. After the original action finishes processing, the queued
 * actions are dispatched sequentially. This reduces the stack depth from
 * O(N²) to O(N).
 *
 * Must be placed FIRST in the middleware chain (before thunk) so it
 * intercepts all dispatches including those from `mwApi.dispatch`.
 */
const rtkQueryInitCascadeFlattener: Middleware = () => (next) => {
  let cascadeDepth = 0;
  const pendingActions: Array<UnknownAction> = [];

  return (action: unknown) => {
    if (
      cascadeDepth > 0 &&
      typeof action === "object" &&
      action !== null &&
      "type" in action &&
      typeof (action as { type: string }).type === "string" &&
      (action as { type: string }).type.endsWith("/config/middlewareRegistered")
    ) {
      pendingActions.push(action as UnknownAction);
      return action;
    }

    cascadeDepth++;
    const result = next(action);
    cascadeDepth--;

    if (cascadeDepth === 0 && pendingActions.length > 0) {
      // Flush queued middlewareRegistered actions sequentially.
      // All RTK Query middlewares have set their initialized flag by now,
      // so no new cascade will be triggered.
      while (pendingActions.length > 0) {
        next(pendingActions.shift());
      }
    }

    return result;
  };
};

export default rtkQueryInitCascadeFlattener;
