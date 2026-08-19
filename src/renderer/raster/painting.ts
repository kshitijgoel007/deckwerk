export type BrushShape = 'round' | 'square';

export interface PaintPoint {
  x: number;
  y: number;
}

export interface PaintStroke {
  color: string;
  size: number;
  shape: BrushShape;
  points: PaintPoint[];
}

type PaintContext = Pick<CanvasRenderingContext2D, 'beginPath' | 'arc' | 'fill' | 'fillRect' | 'fillStyle'>;

/** Convert a pointer in the displayed canvas to a pixel in its backing bitmap. */
export function bitmapPoint(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  bitmapWidth: number,
  bitmapHeight: number,
): PaintPoint {
  return {
    x: ((clientX - rect.left) / rect.width) * bitmapWidth,
    y: ((clientY - rect.top) / rect.height) * bitmapHeight,
  };
}

/** Paint one continuous brush segment using stamps, avoiding gaps on fast drags. */
export function paintSegment(
  ctx: PaintContext,
  from: PaintPoint,
  to: PaintPoint,
  size: number,
  shape: BrushShape,
  color: string,
): void {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const spacing = Math.max(0.5, size / 5);
  const steps = Math.max(1, Math.ceil(distance / spacing));
  ctx.fillStyle = color;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    stampBrush(ctx, {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
    }, size, shape);
  }
}

export function paintStroke(ctx: PaintContext, stroke: PaintStroke): void {
  const first = stroke.points[0];
  if (!first) return;
  if (stroke.points.length === 1) {
    ctx.fillStyle = stroke.color;
    stampBrush(ctx, first, stroke.size, stroke.shape);
    return;
  }
  for (let i = 1; i < stroke.points.length; i++) {
    paintSegment(
      ctx,
      stroke.points[i - 1],
      stroke.points[i],
      stroke.size,
      stroke.shape,
      stroke.color,
    );
  }
}

function stampBrush(
  ctx: PaintContext,
  point: PaintPoint,
  size: number,
  shape: BrushShape,
): void {
  if (shape === 'square') {
    ctx.fillRect(point.x - size / 2, point.y - size / 2, size, size);
    return;
  }
  ctx.beginPath();
  ctx.arc(point.x, point.y, size / 2, 0, Math.PI * 2);
  ctx.fill();
}

export function pixelHex(pixel: ArrayLike<number>): string {
  return `#${[pixel[0], pixel[1], pixel[2]]
    .map((channel) => Math.max(0, Math.min(255, channel ?? 0)).toString(16).padStart(2, '0'))
    .join('')}`;
}
