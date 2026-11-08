/**
 * Faithful ports of the original UI controls used by the login flow.
 * Button: CCtrlButton multi-state vertical strip (state machine grounded in
 *         CCtrlButton::sub_6A43F0: normal=0, press=1, disabled=2, hover=3+).
 * Edit:   CCtrlEdit single-line input drawn over the form's baked input box.
 */
import { imageCount, logicalImage, type Sprite } from "../engine/assets.ts";
import type { Renderer } from "../engine/renderer.ts";
import type { Input, Pointer } from "../engine/input.ts";
import { rectContains, type Rect } from "../engine/types.ts";
import { textSprite } from "./text.ts";

export class Button {
  x: number;
  y: number;
  w: number;
  h: number;
  state = 0; // CCtrlButton::sub_6A43F0: normal=0, press=1, disabled=2, hover=3+
  enabled = true;
  visible = true;
  onClick?: () => void;
  /** Optional forced logical image (e.g. selected character / checked box). */
  stateOverride: number | null = null;
  private stateCount: number;
  private over = false;
  private baseDx = 0;
  private baseDy = 0;

  constructor(
    public sprite: Sprite,
    x: number,
    y: number,
    opts: { stateCount?: number; onClick?: () => void } = {},
  ) {
    this.x = x;
    this.y = y;
    this.stateCount = opts.stateCount ?? imageCount(sprite);
    const first = logicalImage(sprite, 0);
    this.w = first?.w ?? sprite.w;
    this.h = first?.h ?? sprite.h;
    this.baseDx = first?.dx ?? 0;
    this.baseDy = first?.dy ?? 0;
    this.onClick = opts.onClick;
  }

  get rect(): Rect {
    // The logical canvas (w/h) is anchored at x+dx0,y+dy0; hover art may grow
    // beyond the normal source rect, so hit-testing uses the full canvas.
    return { x: this.x + this.baseDx, y: this.y + this.baseDy, w: this.w, h: this.h };
  }

  update(p: Pointer) {
    if (!this.visible) return;
    this.over = rectContains(this.rect, p.x, p.y);
    if (!this.enabled) {
      this.state = Math.min(2, this.stateCount - 1);
      return;
    }
    if (this.stateOverride != null) this.state = Math.min(this.stateOverride, this.stateCount - 1);
    else if (this.over && p.down) this.state = Math.min(1, this.stateCount - 1);
    else if (this.over) this.state = Math.min(3, this.stateCount - 1);
    else this.state = 0;
    if (this.over && p.clicked) this.onClick?.();
  }

  draw(r: Renderer) {
    if (!this.visible) return;
    const img = logicalImage(this.sprite, this.state) ?? logicalImage(this.sprite, 0);
    if (!img) return;
    r.draw(this.sprite, { x: this.x + img.dx, y: this.y + img.dy, w: img.src.w, h: img.src.h }, { src: img.src });
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

  update(p: Pointer, input: Input, dtMs: number) {
    if (!this.visible) return;
    if (p.pressed) this.focused = rectContains(this.rect, p.x, p.y);
    if (this.focused) {
      for (const ch of input.typed) {
        if (ch === "\b") this.value = this.value.slice(0, -1);
        else if (this.value.length < this.maxLength) this.value += ch;
      }
      if (input.justPressed("Enter")) this.onSubmit?.();
      this.caretTimer += dtMs;
      if (this.caretTimer > 500) {
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