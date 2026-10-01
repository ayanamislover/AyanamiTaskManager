type ActivitySource = { runActivity?: <T>(run: () => T) => T };

/**
 * 给一个类原型上的每个方法登记在途操作：调用开始到（异步）结束之间取用过的项目库连接，
 * 不会被别的操作的空闲回收或容量淘汰关掉（见 ProjectDatabasePool.runActivity）。
 * 改原型而不是实例：facade 契约不允许实例上多出函数，原型方法的描述符保持不变。
 */
export function trackProjectActivity<T extends object>(
  prototype: T,
  databasesOf: (instance: T) => ActivitySource | undefined,
): void {
  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === "constructor") continue;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    const method: unknown = descriptor?.value;
    if (!descriptor || typeof method !== "function") continue;
    const tracked = {
      [name](this: T, ...args: unknown[]): unknown {
        const databases = databasesOf(this);
        const call = () => method.apply(this, args) as unknown;
        return databases?.runActivity ? databases.runActivity(call) : call();
      },
    }[name]!;
    Object.defineProperty(prototype, name, { ...descriptor, value: tracked });
  }
}
