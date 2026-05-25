import { useCallback, useRef } from "react";

/**
 * Like useCallback, but returns a function whose identity NEVER changes across
 * renders, while still calling the latest version of the supplied function.
 *
 * Use case: passing callbacks to React.memo'd children. A normal arrow / fn
 * declaration is recreated each render, defeating shallow-prop comparison;
 * useCallback with deps forces you to enumerate every closure variable. This
 * hook trades a small indirection for stable identity + always-fresh behavior.
 */
export function useStableCallback<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: TArgs) => ref.current(...args), []);
}
