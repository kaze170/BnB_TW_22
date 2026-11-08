/**
 * Faithful ports of the original UI controls used by the login flow.
 * Button: CCtrlButton multi-state vertical strip (state machine grounded in
 *         CCtrlButton::sub_6A43F0: normal=0, press=1, disabled=2, hover=3+).
 * Edit:   CCtrlEdit single-line input drawn over the form's baked input box.
 */
import type { Sprite } from "../engine/assets.ts";
import type { Renderer } from "../engine/renderer.ts";
import type { Input, Pointer } from "../engine/input.ts";
import { rectContains, type Rect } from "../engine/types.ts";
import { textSprite } from "./text.ts";

export class Button {
  x: number;
  y: number;
  w: number;
  h: number;
  state = 0; // 0 normal, 1 press, 2 disabled, 3 hover
  enabled = true;
  visible = true;
  onClick?: () => void;
  private frameH: number;
  private stateCount: number;
  private over = false;

  constructor(
    public sprite: Sprite,
    x: number,
    y: number,
    opts: { stateCount?: number; onClick?: () => void } = {},
  ) {
    this.x = x;
    this.y = y;
    this.stateCount = opts.stateCount ?? sprite.frames.length;
    // single-frame sprite whose height stacks N states vertically
    this.frameH = sprite.frames.length === 1 ? sprite.h / this.stateCount : sprite.frames[0]!.h;
    this.w = sprite.frames.length === 1 ? sprite.w : sprite.frames[0]!.w;
    this.h = this.frameH;
    this.onClick = opts.onClick;
  }

  get rect(): Rect {
    return { x: this.x, y: this.y, w: this.w, h: this.h };
  }

  update(p: Pointer) {
    if (!this.visible) return;
    this.over = rectContains(this.rect, p.x, p.y);
    if (!this.enabled) {
      this.state = 2;
      return;
    }
    if (this.over && p.down) this.state = 1;
    else if (this.over) this.state = Math.min(3, this.stateCount - 1);
    else this.state = 0;
    if (this.over && p.clicked) this.onClick?.();
  }

  draw(r: Renderer) {
    if (!this.visible) return;
    const src =
      this.sprite.frames.length === 1
        ? { x: 0, y: this.state * this.frameH, w: this.w, h: this.frameH }
        : this.sprite.frames[this.state] ?? this.sprite.frames[0]!;
    r.draw(this.sprite, this.rect, { src });
  }
}

export class Edit {
  value = "";
  focused = false;
  maxLength = 16;
  visible = true;
  onSubmit?: () => void;
  private caretOn = true;
  private caretTimer = 0;

  constructor(
    public x: number,
    public y: number,
    public w: number,
    public h: number,
    public password = false,
    public textStyle: { size?: number; color?: string } = {},
  ) {}

  get rect(): Rect {
    return { x: this.x, y: this.y, w: this.w, h: this.h };
  }

  update(p: Pointer, input: Input, dt: number) {
    if (!this.visible) return;
    if (p.pressed) this.focused = rectContains(this.rect, p.x, p.y);
    if (this.focused) {
      for (const ch of input.typed) {
        if (ch === "\b") this.value = this.value.slice(0, -1);
        else if (this.value.length < this.maxLength) this.value += ch;
      }
      if (input.justPressed("Enter")) this.onSubmit?.();
      this.caretTimer += dt;
      if (this.caretTimer > 0.5) {
        this.caretTimer = 0;
        this.caretOn = !this.caretOn;
      }
    }
  }

  draw(r: Renderer) {
    if (!this.visible) return;
    const shown = this.password ? "•".repeat(this.value.length) : this.value;
    const size = this.textStyle.size ?? 13;
    if (shown) {
      const spr = textSprite(shown, { size, color: this.textStyle.color ?? "#1a1a1a" });
      const ty = this.y + (this.h - spr.h) / 2;
      r.draw(spr, { x: this.x + 4, y: ty, w: spr.w, h: spr.h });
    }
    if (this.focused && this.caretOn) {
      const w = shown ? textSprite(shown, { size }).w : 0;
      const caret = textSprite("|", { size, color: "#1a1a1a" });
      r.draw(caret, { x: this.x + 4 + w, y: this.y + (this.h - caret.h) / 2, w: caret.w, h: caret.h });
    }
  }
}