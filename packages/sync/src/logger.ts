/** 连接器与会话共用的日志接口。单独成文件，避免 errors.ts 为了一个类型去依赖 session.ts 形成导入环。 */
export type SyncLogger = {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
};
