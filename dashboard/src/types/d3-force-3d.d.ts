// Minimal ambient types for `d3-force-3d`.
//
// The package ships without TypeScript types, but `react-force-graph-2d` uses
// it internally so the runtime is guaranteed to be present. We only declare
// the small surface we actually consume — extend as needed.
declare module "d3-force-3d" {
  /**
   * A force that can be installed on a d3 force simulation.
   * `initialize` is typed loosely (`...args: any[]`) so it remains assignable
   * to `react-force-graph-2d`'s `ForceFn<NodeObject<...>>` regardless of the
   * shape of the consumer's node type.
   */
  export interface Force {
    (alpha: number): void
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initialize?: (nodes: any[], ...args: any[]) => void
    [key: string]: unknown
  }

  /** Configurable collision force. */
  export interface CollideForce<N> extends Force {
    radius(r: number | ((n: N, i: number, ns: N[]) => number)): CollideForce<N>
    strength(s: number): CollideForce<N>
    iterations(n: number): CollideForce<N>
  }

  export function forceCollide<N = unknown>(
    radius?: number | ((n: N, i: number, ns: N[]) => number),
  ): CollideForce<N>
}
