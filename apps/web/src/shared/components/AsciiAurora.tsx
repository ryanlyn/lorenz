import { useEffect, useRef } from "react";

const FIELD_HEIGHT = 440;
const CELL = 14;
/** Density ramp: intensity picks progressively heavier glyphs. */
const RAMP = [".", ":", ";", "+", "x", "#"] as const;
const TEAL = [45, 212, 168] as const;
const PETROL = [76, 192, 224] as const;
const LIME = [163, 230, 53] as const;
const CORAL = [239, 99, 81] as const;

/** Deterministic per-cell hash so the field is stable across redraws. */
function cellHash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) ^ 0x5bf03635;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function gaussian(dx: number, dy: number, radius: number): number {
  return Math.exp(-(dx * dx + dy * dy) / (radius * radius));
}

function draw(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const width = canvas.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(FIELD_HEIGHT * dpr);
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, FIELD_HEIGHT);
  ctx.font = `11px ui-monospace, "SF Mono", Menlo, monospace`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";

  const cols = Math.ceil(width / CELL);
  const rows = Math.ceil(FIELD_HEIGHT / CELL);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const nx = (col * CELL) / width;
      const ny = (row * CELL) / FIELD_HEIGHT;

      // Two off-canvas glow centers matching the old smooth-gradient wash.
      const left = gaussian(nx - 0.1, (ny + 0.06) * 0.75, 0.26);
      const right = gaussian(nx - 0.9, (ny + 0.08) * 0.65, 0.3);
      const fade = Math.max(0, 1 - ny) ** 1.5;
      const intensity = (left + right) * fade;

      // Probabilistic dithering: cells survive in proportion to local glow,
      // so density falls off organically instead of forming a texture wall.
      if (cellHash(col, row) > intensity * 1.2) continue;

      // Jitter the glyph pick per cell to break up horizontal banding.
      const charJitter = cellHash(col * 31 + 17, row * 5 + 29);
      const charIndex = Math.floor(intensity * RAMP.length - 0.5 + charJitter);
      const char = RAMP[Math.max(0, Math.min(RAMP.length - 1, charIndex))];

      // Blend hue by which glow dominates; sprinkle rare attractor "debris".
      const spark = cellHash(col * 7 + 3, row * 13 + 1);
      let rgb: readonly [number, number, number];
      if (spark > 0.988 && intensity > 0.12) {
        rgb = spark > 0.994 ? CORAL : LIME;
      } else {
        const t = right / (left + right);
        rgb = [
          Math.round(TEAL[0] + (PETROL[0] - TEAL[0]) * t),
          Math.round(TEAL[1] + (PETROL[1] - TEAL[1]) * t),
          Math.round(TEAL[2] + (PETROL[2] - TEAL[2]) * t),
        ];
      }

      const alpha =
        Math.min(0.42, 0.08 + intensity * 0.5) *
        (0.65 + 0.35 * cellHash(col * 3 + 7, row * 11 + 5));
      ctx.fillStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha.toFixed(3)})`;
      ctx.fillText(char, col * CELL + CELL / 2, row * CELL + CELL / 2);
    }
  }
}

/**
 * ASCII-dithered aurora: the brand gradient rendered as a character field,
 * echoing the pixelated Lorenz attractor artwork. Purely decorative.
 */
export function AsciiAurora() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const redraw = () => draw(canvas);
    redraw();
    window.addEventListener("resize", redraw);
    return () => window.removeEventListener("resize", redraw);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-0 h-[440px] w-full"
    />
  );
}
