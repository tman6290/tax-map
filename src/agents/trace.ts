// Trace arrays that report each step as it is pushed, so the API can stream progress while the agents run.
import type { TraceStep } from "./types.js";

/**
 * A trace array that also reports each step as it is pushed, so a caller (the web API) can stream
 * the agents' progress while they run. Without a listener it is an ordinary array.
 */
export function observedTrace(onStep?: (step: TraceStep) => void): TraceStep[] {
  const trace: TraceStep[] = [];
  if (!onStep) return trace;
  const push = trace.push.bind(trace);
  trace.push = (...steps: TraceStep[]) => {
    const n = push(...steps);
    for (const s of steps) {
      try {
        onStep(s);
      } catch {
        // a failing listener must not break the agent run
      }
    }
    return n;
  };
  return trace;
}
