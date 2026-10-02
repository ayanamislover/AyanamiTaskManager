import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QR_QUIET_ZONE, QrCode, qrMatrix } from "../src/components/qr-code.js";

// 形状和真实配对码一样：atm1: + base64url(JSON)，两三百字节。
const pairingCode = `atm1:${Buffer.from(
  JSON.stringify({
    v: 1,
    u: "https://relay.example.com",
    a: "atm",
    t: "tok_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG",
    s: "0123456789abcdef01234567",
    k: "q83vEjRWeJC9mbXq4R8KgnpXU2hkKc1xZkM9Qd4f0aA",
    n: "书房电脑",
  }),
).toString("base64url")}`;

function darkCells(path: string): Set<string> {
  return new Set([...path.matchAll(/M(\d+) (\d+)h1v1h-1z/gu)].map((m) => `${m[1]},${m[2]}`));
}

describe("配对二维码", () => {
  it("四周留足 4 个模块的静区，深色模块全在码区内", () => {
    const matrix = qrMatrix(pairingCode);
    expect(matrix.size).toBe(matrix.modules + QR_QUIET_ZONE * 2);
    const cells = [...darkCells(matrix.path)].map((cell) => cell.split(",").map(Number));
    expect(cells.length).toBeGreaterThan(100);
    for (const [x, y] of cells) {
      expect(x).toBeGreaterThanOrEqual(QR_QUIET_ZONE);
      expect(y).toBeGreaterThanOrEqual(QR_QUIET_ZONE);
      expect(x).toBeLessThan(QR_QUIET_ZONE + matrix.modules);
      expect(y).toBeLessThan(QR_QUIET_ZONE + matrix.modules);
    }
  });

  it("三个定位角都在：左上 7×7 外框是深色，紧邻的分隔带是浅色", () => {
    const matrix = qrMatrix(pairingCode);
    const cells = darkCells(matrix.path);
    const q = QR_QUIET_ZONE;
    const far = q + matrix.modules - 7;
    for (const [ox, oy] of [
      [q, q],
      [far, q],
      [q, far],
    ] as const) {
      for (let i = 0; i < 7; i += 1) {
        expect(cells.has(`${ox + i},${oy}`)).toBe(true);
        expect(cells.has(`${ox},${oy + i}`)).toBe(true);
      }
      // 定位图案中心 3×3 实心。
      expect(cells.has(`${ox + 3},${oy + 3}`)).toBe(true);
    }
    expect(cells.has(`${q + 7},${q}`)).toBe(false);
  });

  it("同一段文本编出同一张码，不同文本不同", () => {
    expect(qrMatrix(pairingCode).path).toBe(qrMatrix(pairingCode).path);
    expect(qrMatrix(`${pairingCode}x`).path).not.toBe(qrMatrix(pairingCode).path);
  });

  it("SVG 内联、深码浅底写死颜色，不跟主题变", () => {
    const markup = renderToStaticMarkup(createElement(QrCode, { text: "atm1:abc", label: "码" }));
    expect(markup).toMatch(/^<svg class="atm-qr-code" role="img" aria-label="码"/u);
    expect(markup).toContain('fill="#ffffff"');
    expect(markup).toContain('fill="#1b1326"');
    expect(markup).not.toMatch(/var\(--|href=|<image/u);
  });
});
