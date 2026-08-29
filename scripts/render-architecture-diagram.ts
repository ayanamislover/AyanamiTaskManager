/**
 * 生成 README 的产品结构图。
 *
 * 一份布局出明暗两版 SVG，因为 GitHub 会 sanitize Markdown 里的内联 <svg>：图必须是文件，
 * 再用 <picture> 按 prefers-color-scheme 切换。手维护两份迟早走样，所以这里只留一处真理源。
 *
 * 配色直接取自 packages/ui/src/tokens.css，不另起一套——README 里的图和产品本体是同一个设计系统。
 *
 *   pnpm exec tsx scripts/render-architecture-diagram.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Palette = {
  bg: string;
  surface: string;
  surfaceMuted: string;
  text: string;
  textMuted: string;
  border: string;
  borderStrong: string;
  primary: string;
  primarySoft: string;
};

const LIGHT: Palette = {
  bg: "#f7f5f0",
  surface: "#fffcf8",
  surfaceMuted: "#f3efe8",
  text: "#24212b",
  textMuted: "#77717f",
  border: "#e6ded3",
  borderStrong: "#cdc2b4",
  primary: "#7257d6",
  primarySoft: "#f0ebff",
};

const DARK: Palette = {
  bg: "#1f1d23",
  surface: "#29262e",
  surfaceMuted: "#332f38",
  text: "#f2eef6",
  textMuted: "#aaa2b2",
  border: "#46404d",
  borderStrong: "#6b6376",
  primary: "#9b86e8",
  primarySoft: "#332b4d",
};

const FONT = "'Segoe UI Variable','Segoe UI','PingFang SC','Microsoft YaHei UI',sans-serif";
const MONO = "'Cascadia Mono','SFMono-Regular',Consolas,monospace";

/** 四条竖列 + 一条底部通道。列宽与间距固定，改一处即可整体重排。 */
// GitHub 的正文栏宽约 900px。图按接近该宽度出，避免被缩放后字号掉到读不清。
const COLUMN_WIDTH = 176;
const COLUMN_GAP = 64;
const MARGIN = 28;
const WIDTH = MARGIN * 2 + COLUMN_WIDTH * 4 + COLUMN_GAP * 3;
const HEIGHT = 386;

const CARD_TOP = 80;
const CARD_HEIGHT = 176;
const ITEM_HEIGHT = 40;
const ITEM_GAP = 12;
const LANE_TOP = 310;
const LANE_HEIGHT = 40;
const CHIP_WIDTH = 150;

const columnX = (index: number): number => MARGIN + index * (COLUMN_WIDTH + COLUMN_GAP);

type Column = { label: string; caption: string; items: string[]; accent?: boolean };

const COLUMNS: Column[] = [
  {
    label: "AI Agents",
    caption: "领取 · 推进 · 交接",
    items: ["Codex", "Claude Desktop", "Claude Code"],
  },
  {
    label: "本地动态 Bridge",
    caption: "每次启动轮换令牌",
    items: ["core", "memory", "actions"],
    accent: true,
  },
  {
    label: "共享应用服务",
    caption: "唯一写入入口",
    items: ["命令与事务", "查询与读模型", "幂等与投影"],
  },
  {
    label: "本地存储",
    caption: "loopback · 无云端账号",
    items: ["全局 Registry", "每项目 SQLite"],
  },
];

const ARROW_LABELS = ["MCP stdio", "本地回环", "事务写入"];

function escapeText(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function label(
  x: number,
  y: number,
  value: string,
  size: number,
  fill: string,
  bold = false,
): string {
  const weight = bold ? ' font-weight="600"' : "";
  return `    <text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}"${weight} fill="${fill}">${escapeText(value)}</text>`;
}

function column(index: number, spec: Column, palette: Palette): string {
  const x = columnX(index);
  // 各列条目数不同（存储列只有两条）。垂直居中，避免短列的卡片下半空着。
  const stackHeight = spec.items.length * ITEM_HEIGHT + (spec.items.length - 1) * ITEM_GAP;
  const itemsTop = CARD_TOP + (CARD_HEIGHT - stackHeight) / 2;
  const items = spec.items
    .map((item, position) => {
      const y = itemsTop + position * (ITEM_HEIGHT + ITEM_GAP);
      const fill = spec.accent ? palette.primarySoft : palette.surfaceMuted;
      const stroke = spec.accent ? palette.primary : palette.border;
      const textFill = spec.accent ? palette.primary : palette.text;
      const family = spec.accent ? MONO : FONT;
      return `    <rect x="${x + 18}" y="${y}" width="${COLUMN_WIDTH - 36}" height="${ITEM_HEIGHT}" rx="9" fill="${fill}" stroke="${stroke}" stroke-width="1" />
    <text x="${x + COLUMN_WIDTH / 2}" y="${y + ITEM_HEIGHT / 2 + 5}" text-anchor="middle" font-family="${family}" font-size="14" fill="${textFill}">${escapeText(item)}</text>`;
    })
    .join("\n");
  // bridge 是这套架构的分界点，用主色描边表达主次；厚色条会压过卡片里的内容。
  const cardStroke = spec.accent ? palette.primary : palette.border;

  return `  <g>
${label(x, 34, spec.label, 15, palette.text, true)}
${label(x, 56, spec.caption, 12, palette.textMuted)}
    <rect x="${x}" y="${CARD_TOP}" width="${COLUMN_WIDTH}" height="${CARD_HEIGHT}" rx="14" fill="${palette.surface}" stroke="${cardStroke}" stroke-width="${spec.accent ? 1.5 : 1}" />
${items}
  </g>`;
}

function arrow(index: number, palette: Palette): string {
  const from = columnX(index) + COLUMN_WIDTH;
  const to = columnX(index + 1);
  const midY = CARD_TOP + CARD_HEIGHT / 2;
  return `  <g>
    <line x1="${from + 10}" y1="${midY}" x2="${to - 6}" y2="${midY}" stroke="${palette.borderStrong}" stroke-width="1.5" marker-end="url(#atm-arrow)" />
    <text x="${(from + to) / 2}" y="${midY - 13}" text-anchor="middle" font-family="${MONO}" font-size="11" fill="${palette.textMuted}">${escapeText(ARROW_LABELS[index] ?? "")}</text>
  </g>`;
}

/** 桌面 UI 与 CLI 不经 bridge，直接落到同一套应用服务上——图上必须看得出这一点。 */
function localClients(palette: Palette): string {
  const chips = ["Electron 桌面 UI", "CLI"];
  const riserX = columnX(2) + COLUMN_WIDTH / 2;
  const laneMidY = LANE_TOP + LANE_HEIGHT / 2;
  const boxes = chips
    .map((chip, position) => {
      const x = MARGIN + position * (CHIP_WIDTH + 16);
      return `    <rect x="${x}" y="${LANE_TOP}" width="${CHIP_WIDTH}" height="${LANE_HEIGHT}" rx="9" fill="${palette.surface}" stroke="${palette.border}" stroke-width="1" />
    <text x="${x + CHIP_WIDTH / 2}" y="${LANE_TOP + 25}" text-anchor="middle" font-family="${FONT}" font-size="13" fill="${palette.text}">${escapeText(chip)}</text>`;
    })
    .join("\n");
  const laneRight = MARGIN + CHIP_WIDTH * 2 + 16;
  return `  <g>
    <line x1="${MARGIN}" y1="${LANE_TOP - 32}" x2="${WIDTH - MARGIN}" y2="${LANE_TOP - 32}" stroke="${palette.border}" stroke-width="1" stroke-dasharray="3 5" />
${label(MARGIN, LANE_TOP - 10, "同机直连，不经 MCP", 12, palette.textMuted)}
${boxes}
    <path d="M ${laneRight} ${laneMidY} H ${riserX} V ${CARD_TOP + CARD_HEIGHT + 6}" fill="none" stroke="${palette.borderStrong}" stroke-width="1.5" marker-end="url(#atm-arrow)" />
  </g>`;
}

function render(palette: Palette): string {
  const columns = COLUMNS.map((spec, index) => column(index, spec, palette)).join("\n");
  const arrows = COLUMNS.slice(0, -1)
    .map((_spec, index) => arrow(index, palette))
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img" aria-label="AyanamiTaskManager 产品结构：AI Agents 经 MCP 连接本地动态 bridge，与 Electron 桌面 UI、CLI 共用同一套应用服务，写入全局 registry 与每项目 SQLite">
  <defs>
    <marker id="atm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="${palette.borderStrong}" />
    </marker>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" rx="18" fill="${palette.bg}" />
${columns}
${arrows}
${localClients(palette)}
</svg>
`;
}

const outputDir = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "assets");
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "architecture-light.svg"), render(LIGHT), "utf8");
writeFileSync(join(outputDir, "architecture-dark.svg"), render(DARK), "utf8");
process.stdout.write(`wrote architecture-light.svg and architecture-dark.svg to ${outputDir}\n`);
