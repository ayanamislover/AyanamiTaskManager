/**
 * 测试拉起的 ATM 宿主不打扰正在用这台电脑的人：宿主认 `ATM_BACKGROUND_WINDOW=1`
 * （`apps/desktop/native/host/src/app.rs` 的 `background_window`），窗口照常显示、照常量「可见」，
 * 但不激活、不抢焦点，显示后压到所有窗口下面。
 *
 * 拉起宿主的脚本都先导入这个模块：它给本进程的环境设上开关，之后由本进程拉起、继承环境的宿主
 * （以及宿主再拉起的 setup、第二实例）都在后台。
 */
export const BACKGROUND_WINDOW = "ATM_BACKGROUND_WINDOW";

process.env[BACKGROUND_WINDOW] = "1";
