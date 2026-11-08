import { describe, expect, test } from "bun:test";
import { Input } from "../src/client/engine/input.ts";

describe("canvas input", () => {
  test("a press+release between animation frames still produces one click", () => {
    const canvasHandlers = new Map<string, (e: any) => void>();
    const windowHandlers = new Map<string, (e: any) => void>();
    const canvas = {
      addEventListener: (t: string, h: (e: any) => void) => canvasHandlers.set(t, h),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    } as unknown as HTMLCanvasElement;
    const oldWindow = (globalThis as any).window;
    (globalThis as any).window = { addEventListener: (t: string, h: (e: any) => void) => windowHandlers.set(t, h) };
    try {
      const input = new Input(canvas);
      const e = { clientX: 123, clientY: 456 };
      canvasHandlers.get("mousedown")!(e);
      windowHandlers.get("mouseup")!(e); // no beginFrame/endFrame in between
      const p = input.beginFrame();
      expect(p.x).toBe(123);
      expect(p.y).toBe(456);
      expect(p.pressed).toBe(true);
      expect(p.clicked).toBe(true);
      input.endFrame();
      expect(input.beginFrame().clicked).toBe(false);
    } finally {
      (globalThis as any).window = oldWindow;
    }
  });
});
