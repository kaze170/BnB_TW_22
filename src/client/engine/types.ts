/** Core geometry types mirroring the original RECT-based blit model. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Original client back-buffer resolution (confirmed from CAStage.jpg = 800x600). */
export const SCREEN_W = 800;
export const SCREEN_H = 600;

/** Map cell size in pixels (CGOTile::sub_45D6CA: 40*n). */
export const TILE_SIZE = 40;

export function rect(x: number, y: number, w: number, h: number): Rect {
  return { x, y, w, h };
}

export function rectContains(r: Rect, px: number, py: number): boolean {
  return px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
}