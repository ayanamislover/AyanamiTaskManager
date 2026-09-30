// 进程内变更通知：写入成功后唤醒同一 app 上挂起的长轮询。
import { EventEmitter } from "node:events";

const SHUTDOWN = Symbol("shutdown");

export class ChangeNotifier {
  private readonly emitter = new EventEmitter();

  constructor() {
    // 名额由 WaiterGate 限死（全局默认 256），这里不再设监听器上限，免得触发泄漏警告。
    this.emitter.setMaxListeners(0);
  }

  notify(appId: string): void {
    this.emitter.emit(appId);
  }

  /** 订阅某个 app 的下一次变更或进程关闭；返回取消订阅的函数。 */
  subscribe(appId: string, listener: () => void): () => void {
    this.emitter.on(appId, listener);
    this.emitter.on(SHUTDOWN, listener);
    return () => {
      this.emitter.off(appId, listener);
      this.emitter.off(SHUTDOWN, listener);
    };
  }

  /** 关闭时让所有长轮询立即按「无新变更」返回。 */
  shutdown(): void {
    this.emitter.emit(SHUTDOWN);
  }
}
