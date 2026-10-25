// The process's shared H-MEM and World Model, created on first use from the environment.
import { HMem } from "./hmem/index.js";
import { WorldModelEngine } from "./world_model/index.js";

export interface Engines {
  hmem: HMem;
  world: WorldModelEngine;
}

let engines: Engines | undefined;

/**
 * The process's H-MEM and World Model, created on first use from HMEM_DIR / HMEM_LOG_DIR / WM_DIR /
 * WM_LOG_DIR (defaults data/memory, logs/hmem, data/world_model, logs/world_model).
 */
export function getEngines(): Engines {
  engines ??= { hmem: new HMem(), world: new WorldModelEngine() };
  return engines;
}

/** Drops the shared engines so the next getEngines() reads the environment again (tests). */
export function resetEngines(): void {
  engines = undefined;
}
