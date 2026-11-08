/**
 * CGOGameResult layout recovered from CA.exe:
 * - sub_4548CD draws Game/PatResultDlg as a 10px 9-slice (top edge 0x208=520,
 *   right edge x=0x212=530 → 540px wide).
 * - sub_454DAC iterates 8 rows, y = 51 + 25*i.
 * - sub_454A43 draws the row portrait at x=102 and name at x=121.
 * - sub_454E96 draws the score bar at x=329, second column at x=399 and the
 *   award badge at x=458. sub_454B49 computes bar width = 60*value/999 and
 *   composes it from ResultImg logical images 46/47/48/49 with 30/15/10/rest
 *   segment thresholds.
 *
 * The vertical-slice server supplies its own stats/awards; this module only
 * encodes the recovered client geometry.
 */
export const RESULT_DIALOG_WIDTH = 540;
export const RESULT_ROW_Y0 = 51;
export const RESULT_ROW_PITCH = 25;
export const RESULT_MAX_ROWS = 8;
export const RESULT_RANK_X = 29;
export const RESULT_PORTRAIT_X = 102;
export const RESULT_NAME_X = 121;
export const RESULT_BAR_X = 329;
export const RESULT_COL2_X = 399;
export const RESULT_AWARD_X = 458;

export function resultBarWidth(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(60, Math.floor((60 * value) / 999));
}

export interface ResultBarSegment { image: number; x: number; w: number }

/** ResultImg fill segments exactly as sub_454B49 thresholds them. */
export function resultBarSegments(value: number): ResultBarSegment[] {
  const w = resultBarWidth(value);
  if (w <= 0) return [];
  if (w < 31) return [{ image: 46, x: 0, w }];
  const segs: ResultBarSegment[] = [{ image: 46, x: 0, w: 30 }];
  const s47 = Math.min(15, w - 30);
  if (s47 > 0) segs.push({ image: 47, x: 30, w: s47 });
  const s48 = Math.max(0, Math.min(10, w - 45));
  if (s48 > 0) segs.push({ image: 48, x: 45, w: s48 });
  const s49 = Math.max(0, w - 55);
  if (s49 > 0) segs.push({ image: 49, x: 55, w: s49 });
  return segs;
}

export function resultDialogHeight(rowCount: number): number {
  const rows = Math.max(1, Math.min(RESULT_MAX_ROWS, rowCount));
  return RESULT_ROW_Y0 + rows * RESULT_ROW_PITCH + 16;
}
