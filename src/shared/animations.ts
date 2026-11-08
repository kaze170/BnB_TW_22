/**
 * Original CGameObjectTemplate animation tables recovered from ObjectTable
 * descriptions (CA.exe sub_4625B7). Each group is a list of
 * [logicalImageIndex, durationTicks] pairs in the 30 ms fixed-step domain.
 *
 * CGOFlame is special: sub_45436D removes a flame segment when its tick counter
 * reaches the group's *frame count* (sub_45FE8B), and sub_454545 uses the
 * counter itself as the logical image index. All Flame/Flame durations are 1.
 */
import animationsJson from "../../data/original/objectAnimations.json";
import { ORIGINAL_TICK_MS } from "./timing.ts";

export interface AnimationGroup {
  name: string;
  asset: string;
  /** [logicalImageIndex, durationTicks]; duration -1 means hold. */
  frames: [number, number][];
}

export const OBJECT_ANIMATIONS = animationsJson as unknown as Record<string, AnimationGroup[]>;

export const FLAME_OBJECT = "Flame/Flame";
export const BOMB_OBJECT = "Bomb/Bomb";

/** Simulation direction order is down/up/left/right; Flame/Flame blocks are
 * left(15)/up(30)/right(45)/down(60), matching CGOBomber direction 0/1/2/3. */
export const FLAME_DIR_FROM_SIM = [3, 1, 0, 2] as const;
/** Character/Cxx_A walk groups: 20 left, 21 up, 22 right, 23 down. */
export const CHARACTER_WALK_GROUP = [23, 21, 20, 22] as const;
export const CHARACTER_STOP_GROUP = [15, 13, 12, 14] as const;

export function animationGroup(object: string, group: number): AnimationGroup | undefined {
  return OBJECT_ANIMATIONS[object]?.[group];
}

export function animationFrameCount(object: string, group: number): number {
  return animationGroup(object, group)?.frames.length ?? 0;
}

/** CGOFlame lifetime = number of (image,duration) pairs * 30 ms. */
export function flameLifetimeMs(object: string, group: number): number {
  return animationFrameCount(object, group) * ORIGINAL_TICK_MS;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Normal bomb center: sub_4E61E3 schedules group power-1 (FireC01..). */
export function flameCenterGroup(power: number): number {
  return clamp(power - 1, 0, 14);
}

/** Normal bomb arm/tip: sub_4E3CBE schedules 15*dir + 14 + remainingRange,
 * where remainingRange = power - (distance - 1). distance is 1-based. */
export function flameArmGroup(power: number, simDir: number, distance: number): number {
  const dir = FLAME_DIR_FROM_SIM[simDir] ?? 0;
  const remaining = clamp(power - distance + 1, 1, 15);
  return dir * 15 + 14 + remaining;
}

/** Generic CGameObjectTemplate playback (sub_45F608): advance one logical
 * image after its duration ticks; -1 holds forever; loop wraps to frame 0. */
export function animationImageAtTicks(group: AnimationGroup | undefined, ticks: number, loop = true): number {
  const frames = group?.frames;
  if (!frames?.length) return 0;
  let t = Math.max(0, Math.floor(ticks));
  if (loop) {
    const total = frames.reduce((sum, [, duration]) => sum + (duration > 0 ? duration : 0), 0);
    if (total > 0) t %= total;
  }
  for (const [image, duration] of frames) {
    if (duration < 0) return image;
    if (t < duration) return image;
    t -= duration;
  }
  return frames[frames.length - 1]![0];
}

export function animationDurationMs(group: AnimationGroup | undefined): number {
  if (!group?.frames.length) return 0;
  return group.frames.reduce((sum, [, duration]) => sum + (duration > 0 ? duration : 0), 0) * ORIGINAL_TICK_MS;
}
