import qrcode from "qrcode-generator";

/** QR 规范要求四周至少 4 个模块宽的空白（静区），少了很多扫码器认不出来。 */
export const QR_QUIET_ZONE = 4;

/**
 * 把文本编成二维码的一条 SVG 路径：每个深色模块一个 1×1 的小方块，坐标已经加上静区偏移。
 * 纠错级别用 M（约 15% 可恢复），配对码两三百字节时是 60 多个模块见方。
 */
export function qrMatrix(text: string): { size: number; modules: number; path: string } {
  const code = qrcode(0, "M");
  code.addData(text, "Byte");
  code.make();
  const modules = code.getModuleCount();
  const commands: string[] = [];
  for (let row = 0; row < modules; row += 1) {
    for (let col = 0; col < modules; col += 1) {
      if (code.isDark(row, col)) {
        commands.push(`M${col + QR_QUIET_ZONE} ${row + QR_QUIET_ZONE}h1v1h-1z`);
      }
    }
  }
  return { size: modules + QR_QUIET_ZONE * 2, modules, path: commands.join("") };
}

/**
 * 内联 SVG 二维码，不引外部资源。颜色写死成「深码浅底」：扫码器只认这一种，
 * 深色主题下也不能跟着换成浅码深底。
 */
export function QrCode({
  text,
  label,
  size = 248,
}: {
  text: string;
  label: string;
  size?: number;
}) {
  const matrix = qrMatrix(text);
  return (
    <svg
      className="atm-qr-code"
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${matrix.size} ${matrix.size}`}
      shapeRendering="crispEdges"
    >
      <rect width={matrix.size} height={matrix.size} fill="#ffffff" />
      <path d={matrix.path} fill="#1b1326" />
    </svg>
  );
}
