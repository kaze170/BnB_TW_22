/** Mouse/keyboard input mapped to the 800x600 back-buffer coordinate space. */
import { SCREEN_W, SCREEN_H } from "./types.ts";

export interface Pointer {
  x: number;
  y: number;
  down: boolean;
  clicked: boolean; // pressed-and-released this frame
  pressed: boolean; // pressed this frame
}

export class Input {
  x = 0;
  y = 0;
  down = false;
  private wasDown = false;
  private pressedFlag = false;
  private releasedFlag = false;
  keys = new Set<string>();
  private keyPressed = new Set<string>();
  /** text typed this frame (for edit controls) */
  typed = "";
  private canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const toLocal = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      this.x = ((e.clientX - r.left) / r.width) * SCREEN_W;
      this.y = ((e.clientY - r.top) / r.height) * SCREEN_H;
    };
    canvas.addEventListener("mousemove", toLocal);
    canvas.addEventListener("mousedown", (e) => {
      toLocal(e);
      this.down = true;
      this.pressedFlag = true;
    });
    window.addEventListener("mouseup", (e) => {
      toLocal(e);
      if (this.down) this.releasedFlag = true;
      this.down = false;
    });
    window.addEventListener("keydown", (e) => {
      if (!this.keys.has(e.key)) this.keyPressed.add(e.key);
      this.keys.add(e.key);
      if (e.key.length === 1) this.typed += e.key;
      if (e.key === "Backspace") this.typed += "\b";
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " ", "Tab"].includes(e.key)) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.key));
  }

  /** Call at end of each frame to compute edge flags. */
  beginFrame(): Pointer {
    const p: Pointer = {
      x: this.x,
      y: this.y,
      down: this.down,
      pressed: this.pressedFlag,
      clicked: this.releasedFlag && this.wasDown,
    };
    return p;
  }

  endFrame() {
    this.wasDown = this.down;
    this.pressedFlag = false;
    this.releasedFlag = false;
    this.typed = "";
    this.keyPressed.clear();
  }

  justPressed(key: string): boolean {
    return this.keyPressed.has(key);
  }
}