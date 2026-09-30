import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { EngineState, SyncEngine } from "../data/engine.js";

export const EngineContext = createContext<SyncEngine | null>(null);

export function useEngine(): SyncEngine {
  const engine = useContext(EngineContext);
  if (!engine) throw new Error("EngineContext 缺失");
  return engine;
}

export function useEngineState(): EngineState {
  const engine = useEngine();
  return useSyncExternalStore(engine.subscribe, engine.getState);
}

/** 相对时间要跟着走：每隔一段时间重新渲染一次。 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
