import { Direction, SCREEN_HEIGHT, SCREEN_WIDTH } from "../shared/constants.ts";
import type { ClientAssetManager, GpuSpriteSheet } from "./assets.ts";
import type { WebAudioEngine } from "./audio.ts";
import type { RGBA, WebGpuRenderer } from "./gpu/renderer.ts";

const P1_ARROW_TO_DIR: Record<string, Direction> = {
  ArrowLeft: Direction.Left,
  ArrowUp: Direction.Up,
  ArrowRight: Direction.Right,
  ArrowDown: Direction.Down,
};

const WASD_TO_DIR: Record<string, Direction> = {
  KeyA: Direction.Left,
  KeyW: Direction.Up,
  KeyD: Direction.Right,
  KeyS: Direction.Down,
};

function drawSheetFrameStretched(
  renderer: WebGpuRenderer,
  sheet: GpuSpriteSheet,
  frameIndex: number,
  x: number,
  y: number,
  w: number,
  h: number,
  color: RGBA = [1, 1, 1, 1],
): boolean {
  if (w <= 0 || h <= 0 || sheet.frames.length === 0) return false;
  const fi = Math.max(0, Math.min(sheet.frames.length - 1, frameIndex));
  const f = sheet.frames[fi]!;
  if (f.width <= 0 || f.height <= 0) return false;
  const tex = sheet.textures[f.texIndex];
  if (!tex) return false;
  const u0 = f.left / tex.width;
  const v0 = f.top / tex.height;
  const u1 = (f.left + f.width) / tex.width;
  const v1 = (f.top + f.height) / tex.height;
  renderer.drawQuad(tex, Math.round(x), Math.round(y), Math.round(w), Math.round(h), u0, v0, u1, v1, color);
  return true;
}

export class UiInputSystem {
  public readonly renderer: WebGpuRenderer;
  public readonly audio: WebAudioEngine;

  public mouseX = 400;
  public mouseY = 300;
  public mouseDown = false;
  public mouseClicked = false;
  public rightClicked = false;
  public wheelDelta = 0;

  public readonly keysDown = new Set<string>();
  public readonly keysJustPressed = new Set<string>();

  // Authentic CA.exe Last-Key-Wins direction stacks!
  private readonly p1ArrowStack: Direction[] = [];
  private readonly wasdStack: Direction[] = [];

  // Hover tracking for authentic button hover SFX, Glob_Tooltip & Etc/Cursor state
  private lastHoveredId: string | null = null;
  private currentFrameHoverId: string | null = null;
  private pendingTooltip: { text: string; x: number; y: number } | null = null;

  // Active text field focus bridged to hidden IME <input>
  private readonly imeInput: HTMLInputElement;
  public activeFieldId: string | null = null;
  private fieldValues = new Map<string, string>();
  private submittedFieldId: string | null = null;

  // Authentic CA.exe CNoticeDlg queue (rendered via Etc/Dlg_Notice + Etc/BtOk)
  private noticeQueue: string[] = [];

  constructor(canvas: HTMLCanvasElement, renderer: WebGpuRenderer, audio: WebAudioEngine) {
    this.renderer = renderer;
    this.audio = audio;

    // Hidden IME input for full Traditional Chinese / ASCII text entry without any DOM overlay!
    this.imeInput = document.createElement("input");
    this.imeInput.type = "text";
    this.imeInput.autocomplete = "off";
    this.imeInput.spellcheck = false;
    this.imeInput.style.cssText =
      "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;";
    document.body.appendChild(this.imeInput);

    this.imeInput.addEventListener("input", () => {
      if (this.activeFieldId) {
        this.fieldValues.set(this.activeFieldId, this.imeInput.value);
      }
    });

    this.imeInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing && this.activeFieldId) {
        e.preventDefault();
        this.submittedFieldId = this.activeFieldId;
      } else if (e.key === "Escape" && this.activeFieldId) {
        e.preventDefault();
        this.activeFieldId = null;
        this.imeInput.blur();
      } else if (e.key === "Tab" && this.activeFieldId) {
        e.preventDefault();
        if (!this.keysDown.has("Tab")) this.keysJustPressed.add("Tab");
      }
    });

    const updateMousePos = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      this.mouseX = ((e.clientX - rect.left) * SCREEN_WIDTH) / Math.max(1, rect.width);
      this.mouseY = ((e.clientY - rect.top) * SCREEN_HEIGHT) / Math.max(1, rect.height);
    };

    canvas.addEventListener("mousemove", updateMousePos);
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("mousedown", (e) => {
      this.audio.unlock();
      updateMousePos(e);
      if (e.button === 0) {
        this.mouseDown = true;
        this.mouseClicked = true;
      } else if (e.button === 2) {
        this.rightClicked = true;
      }
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.mouseDown = false;
    });
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.wheelDelta += Math.sign(e.deltaY);
      },
      { passive: false },
    );

    const pushDir = (stack: Direction[], dir: Direction) => {
      const idx = stack.indexOf(dir);
      if (idx >= 0) stack.splice(idx, 1);
      stack.push(dir);
    };
    const popDir = (stack: Direction[], dir: Direction) => {
      const idx = stack.indexOf(dir);
      if (idx >= 0) stack.splice(idx, 1);
    };

    window.addEventListener("keydown", (e) => {
      this.audio.unlock();
      if (this.activeFieldId && document.activeElement === this.imeInput) {
        if (e.key.startsWith("F") && e.key.length <= 3) {
          e.preventDefault();
          if (!this.keysDown.has(e.code)) this.keysJustPressed.add(e.code);
          this.keysDown.add(e.code);
        }
        return;
      }

      if (
        [
          "ArrowUp",
          "ArrowDown",
          "ArrowLeft",
          "ArrowRight",
          "Space",
          "Tab",
          "AltLeft",
          "AltRight",
        ].includes(e.code)
      ) {
        e.preventDefault();
      }

      if (e.code in P1_ARROW_TO_DIR) {
        pushDir(this.p1ArrowStack, P1_ARROW_TO_DIR[e.code]!);
      }
      if (e.code in WASD_TO_DIR) {
        pushDir(this.wasdStack, WASD_TO_DIR[e.code]!);
      }

      if (!this.keysDown.has(e.code)) {
        this.keysJustPressed.add(e.code);
      }
      this.keysDown.add(e.code);
    });

    window.addEventListener("keyup", (e) => {
      this.keysDown.delete(e.code);
      if (e.code in P1_ARROW_TO_DIR) {
        popDir(this.p1ArrowStack, P1_ARROW_TO_DIR[e.code]!);
      }
      if (e.code in WASD_TO_DIR) {
        popDir(this.wasdStack, WASD_TO_DIR[e.code]!);
      }
    });

    window.addEventListener("blur", () => {
      this.keysDown.clear();
      this.p1ArrowStack.length = 0;
      this.wasdStack.length = 0;
      this.mouseDown = false;
    });
  }

  public get hasNoticeOpen(): boolean {
    return this.noticeQueue.length > 0;
  }

  public getP1Direction(allowWasdFallback: boolean): Direction {
    if (this.p1ArrowStack.length > 0) {
      return this.p1ArrowStack[this.p1ArrowStack.length - 1]!;
    }
    if (allowWasdFallback && this.wasdStack.length > 0) {
      return this.wasdStack[this.wasdStack.length - 1]!;
    }
    return Direction.None;
  }

  public getP2Direction(): Direction {
    if (this.wasdStack.length > 0) {
      return this.wasdStack[this.wasdStack.length - 1]!;
    }
    return Direction.None;
  }

  public endFrameInputReset(): void {
    if (this.currentFrameHoverId && this.currentFrameHoverId !== this.lastHoveredId) {
      this.audio.playSfxById(28); // Button hover tick
    }
    this.lastHoveredId = this.currentFrameHoverId;
    this.currentFrameHoverId = null;
    this.pendingTooltip = null;

    this.mouseClicked = false;
    this.rightClicked = false;
    this.wheelDelta = 0;
    this.keysJustPressed.clear();
    this.submittedFieldId = null;
  }

  /**
   * Queues an authentic CA.exe CNoticeDlg (Etc/Dlg_Notice + Etc/BtOk).
   */
  public pushToast(text: string): void {
    if (!text) return;
    if (this.noticeQueue[this.noticeQueue.length - 1] === text) return;
    this.noticeQueue.push(text);
    if (this.noticeQueue.length > 4) this.noticeQueue.shift();
  }

  public isHovered(x: number, y: number, w: number, h: number): boolean {
    return (
      this.mouseX >= x &&
      this.mouseX <= x + w &&
      this.mouseY >= y &&
      this.mouseY <= y + h
    );
  }

  public markInteractiveHover(id: string): void {
    this.currentFrameHoverId = id;
  }

  public focusField(id: string, initialValue?: string): void {
    if (initialValue !== undefined) {
      this.fieldValues.set(id, initialValue);
    }
    const val = this.fieldValues.get(id) ?? "";
    this.activeFieldId = id;
    this.imeInput.value = val;
    this.imeInput.focus();
  }

  public blurField(): void {
    this.activeFieldId = null;
    this.imeInput.blur();
  }

  public getFieldValue(id: string, defaultValue = ""): string {
    if (!this.fieldValues.has(id)) {
      this.fieldValues.set(id, defaultValue);
    }
    return this.fieldValues.get(id)!;
  }

  public get mouseJustPressed(): boolean {
    return !this.hasNoticeOpen && this.mouseClicked;
  }

  public hitRect(x: number, y: number, w: number, h: number): boolean {
    if (this.hasNoticeOpen) return false;
    return this.isHovered(x, y, w, h);
  }

  public setTooltip(text: string): void {
    this.pendingTooltip = {
      text,
      x: this.mouseX,
      y: this.mouseY - 26,
    };
  }

  public setFieldValue(id: string, val: string): void {
    this.fieldValues.set(id, val);
    if (this.activeFieldId === id) {
      this.imeInput.value = val;
    }
  }

  /**
   * Authentic CA.exe multi-frame .i16 sprite button (CCtrlButton)!
   * Uses native Fx.idd frames ONLY: 0=Normal, 1=MouseOver, 2=MouseDown, 3=Disabled
   * (or +selectedBase for 8/9-frame toggle buttons like Etc/SelChara00..07 & CH_Tab_*).
   */
  public spriteButton(
    assets: ClientAssetManager,
    id: string,
    entryPath: string,
    x: number,
    y: number,
    opts?: {
      disabled?: boolean;
      selected?: boolean;
      selectedBase?: number;
      tooltip?: string;
      hitW?: number;
      hitH?: number;
      overlayLabel?: string;
      overlayColor?: RGBA;
      ignoreNoticeLock?: boolean;
    },
  ): boolean {
    const sheet = assets.getSpriteSync("Fx", entryPath);
    const f0 = sheet?.frames[0];
    const drawX = f0 ? x - f0.pivotX : x;
    const drawY = f0 ? y - f0.pivotY : y;
    const w = opts?.hitW ?? (f0 && f0.width > 0 ? f0.width : 64);
    const h = opts?.hitH ?? (f0 && f0.height > 0 ? f0.height : 24);

    const blocked = this.hasNoticeOpen && !opts?.ignoreNoticeLock;
    const disabled = !!opts?.disabled;
    const hovered = !disabled && !blocked && this.isHovered(drawX, drawY, w, h);
    const pressed = hovered && this.mouseDown;

    if (hovered) {
      this.currentFrameHoverId = id;
      if (opts?.tooltip) {
        this.pendingTooltip = { text: opts.tooltip, x: this.mouseX, y: this.mouseY - 26 };
      }
    }

    if (sheet && sheet.frames.length > 0) {
      const count = sheet.frames.length;
      let frameIdx = 0;
      if (disabled) {
        frameIdx = Math.min(3, count - 1);
      } else if (opts?.selected && opts.selectedBase !== undefined && count > opts.selectedBase) {
        const sub = pressed ? 2 : hovered ? 1 : 0;
        frameIdx = Math.min(count - 1, opts.selectedBase + sub);
      } else if (opts?.selected) {
        frameIdx = count >= 8 ? Math.min(count - 1, 4 + (pressed ? 2 : hovered ? 1 : 0)) : Math.min(2, count - 1);
      } else if (pressed) {
        frameIdx = Math.min(2, count - 1);
      } else if (hovered) {
        frameIdx = Math.min(1, count - 1);
      }
      assets.drawSpriteFrame(sheet, frameIdx, x, y);
    }

    if (opts?.overlayLabel) {
      const yOff = pressed ? 1 : 0;
      this.renderer.drawText(
        opts.overlayLabel,
        drawX + w * 0.5,
        drawY + Math.floor((h - 12) * 0.5) + yOff,
        disabled ? [0.62, 0.65, 0.7, 1] : opts.overlayColor ?? [1, 1, 1, 1],
        { align: "center", bold: true, outlined: true },
      );
    }

    if (hovered && this.mouseClicked) {
      this.mouseClicked = false;
      this.audio.playSfxById(29);
      return true;
    }
    return false;
  }

  /**
   * Draws multi-digit numbers using an original Fx.idd .i16 number sheet
   * (e.g. Game/Timer, Etc/Room_Num, SelectServerStage/CH_Bt_ChNum, Shop/S_MoneyCount, Etc/PageNum).
   */
  public drawSpriteDigits(
    assets: ClientAssetManager,
    entryPath: string,
    digits: string,
    x: number,
    y: number,
    stepX: number,
    frameOffset = 0,
    color: RGBA = [1, 1, 1, 1],
  ): boolean {
    const sheet = assets.getSpriteSync("Fx", entryPath);
    if (!sheet || sheet.frames.length < 10) return false;
    let cx = x;
    for (let i = 0; i < digits.length; i++) {
      const ch = digits[i]!;
      if (ch === "/" && sheet.frames.length > 10) {
        assets.drawSpriteFrame(sheet, 10, cx, y, color);
      } else {
        const code = digits.charCodeAt(i) - 48;
        if (code >= 0 && code <= 9) {
          const fi = Math.min(sheet.frames.length - 1, frameOffset + code);
          assets.drawSpriteFrame(sheet, fi, cx, y, color);
        }
      }
      cx += stepX;
    }
    return true;
  }

  /**
   * Native 9-slice Etc/TextBox renderer (f0..f8, 4x4 pieces) from Fx.idd!
   */
  /**
   * Stretches a single native sprite over an arbitrary rectangle. Used for full-screen
   * veils such as Etc/StageOpacity (a solid 10x10 black tile the engine alpha-blends).
   */
  public drawStretchedSprite(
    assets: ClientAssetManager,
    path: string,
    x: number,
    y: number,
    w: number,
    h: number,
    color: RGBA = [1, 1, 1, 1],
  ): boolean {
    const sheet = assets.getSpriteSync("Fx", path);
    if (!sheet || sheet.frames.length === 0) return false;
    return drawSheetFrameStretched(this.renderer, sheet, 0, x, y, w, h, color);
  }

  /**
   * Generic native 9-slice panel. The sheet must hold the 9 pieces in the
   * Crazy-Arcade order: 0=TL 1=top 2=TR 3=left 4=centre 5=right 6=BL 7=bottom 8=BR.
   */
  public drawNineSliceSprite(
    assets: ClientAssetManager,
    path: string,
    x: number,
    y: number,
    w: number,
    h: number,
    corner = 10,
    color: RGBA = [1, 1, 1, 1],
  ): boolean {
    const sheet = assets.getSpriteSync("Fx", path);
    if (!sheet || sheet.frames.length < 9) return false;
    const c = Math.min(corner, Math.floor(w / 2), Math.floor(h / 2));
    if (c <= 0) return false;
    const iw = Math.max(1, w - c * 2);
    const ih = Math.max(1, h - c * 2);
    let ok = true;
    ok = drawSheetFrameStretched(this.renderer, sheet, 0, x, y, c, c, color) || ok;
    ok = drawSheetFrameStretched(this.renderer, sheet, 1, x + c, y, iw, c, color) || ok;
    ok = drawSheetFrameStretched(this.renderer, sheet, 2, x + w - c, y, c, c, color) || ok;
    ok = drawSheetFrameStretched(this.renderer, sheet, 3, x, y + c, c, ih, color) || ok;
    ok = drawSheetFrameStretched(this.renderer, sheet, 4, x + c, y + c, iw, ih, color) || ok;
    ok = drawSheetFrameStretched(this.renderer, sheet, 5, x + w - c, y + c, c, ih, color) || ok;
    ok = drawSheetFrameStretched(this.renderer, sheet, 6, x, y + h - c, c, c, color) || ok;
    ok = drawSheetFrameStretched(this.renderer, sheet, 7, x + c, y + h - c, iw, c, color) || ok;
    ok = drawSheetFrameStretched(this.renderer, sheet, 8, x + w - c, y + h - c, c, c, color) || ok;
    return ok;
  }

  public drawNineSliceTextBox(
    assets: ClientAssetManager,
    x: number,
    y: number,
    w: number,
    h: number,
    color: RGBA = [1, 1, 1, 0.96],
  ): void {
    const sheet = assets.getSpriteSync("Fx", "Etc/TextBox");
    if (!sheet || sheet.frames.length < 9) {
      this.renderer.drawRect(x, y, w, h, [0, 0, 0, 0.65]);
      return;
    }
    const c = 4;
    const iw = Math.max(1, w - c * 2);
    const ih = Math.max(1, h - c * 2);
    drawSheetFrameStretched(this.renderer, sheet, 0, x, y, c, c, color);
    drawSheetFrameStretched(this.renderer, sheet, 1, x + c, y, iw, c, color);
    drawSheetFrameStretched(this.renderer, sheet, 2, x + w - c, y, c, c, color);
    drawSheetFrameStretched(this.renderer, sheet, 3, x, y + c, c, ih, color);
    drawSheetFrameStretched(this.renderer, sheet, 4, x + c, y + c, iw, ih, color);
    drawSheetFrameStretched(this.renderer, sheet, 5, x + w - c, y + c, c, ih, color);
    drawSheetFrameStretched(this.renderer, sheet, 6, x, y + h - c, c, c, color);
    drawSheetFrameStretched(this.renderer, sheet, 7, x + c, y + h - c, iw, c, color);
    drawSheetFrameStretched(this.renderer, sheet, 8, x + w - c, y + h - c, c, c, color);
  }

  /**
   * Native 9-slice ChatBalloon (Etc/ChatBalloon or Game/ChatBalloon) speech bubble.
   *
   * The 16 frames are one nine-slice per size, laid out as:
   *   f0 TL corner (10x10)   f4 top edge (12x10)     f1 TR corner (10x10)
   *  f14 left edge (10x12)  f11 centre (12x12, black) f15 right edge (10x12)
   *   f2 BL corner (10x10)   f5 bottom edge (12x10)   f3 BR corner (10x10)
   * (f8/f9/f10 are the 13px-tall variants and f6/f7/f12/f13 the 6px-wide narrow ones.)
   * The border is RGB(197,197,197) and the interior darkens to RGB(46,46,46) at the
   * edges and pure black in the centre piece, so the label is drawn in white.
   */
  public drawChatBalloon(
    assets: ClientAssetManager,
    entryPath: "Etc/ChatBalloon" | "Game/ChatBalloon",
    text: string,
    centerX: number,
    bottomY: number,
  ): void {
    if (!text) return;
    const tw = Math.min(180, Math.max(40, this.renderer.measureText(text) + 24));
    const th = 26;
    const bx = Math.round(Math.max(8, Math.min(SCREEN_WIDTH - tw - 8, centerX - tw * 0.5)));
    const by = Math.round(bottomY - th - 8);

    const sheet = assets.getSpriteSync("Fx", entryPath);
    if (sheet && sheet.frames.length >= 16) {
      const c = 10;
      const iw = Math.max(1, tw - c * 2);
      const ih = Math.max(1, th - c * 2);
      drawSheetFrameStretched(this.renderer, sheet, 0, bx, by, c, c);
      drawSheetFrameStretched(this.renderer, sheet, 4, bx + c, by, iw, c);
      drawSheetFrameStretched(this.renderer, sheet, 1, bx + tw - c, by, c, c);
      drawSheetFrameStretched(this.renderer, sheet, 14, bx, by + c, c, ih);
      drawSheetFrameStretched(this.renderer, sheet, 11, bx + c, by + c, iw, ih);
      drawSheetFrameStretched(this.renderer, sheet, 15, bx + tw - c, by + c, c, ih);
      drawSheetFrameStretched(this.renderer, sheet, 2, bx, by + th - c, c, c);
      drawSheetFrameStretched(this.renderer, sheet, 5, bx + c, by + th - c, iw, c);
      drawSheetFrameStretched(this.renderer, sheet, 3, bx + tw - c, by + th - c, c, c);
    } else {
      this.drawNineSliceTextBox(assets, bx, by, tw, th);
    }

    this.renderer.drawText(text, bx + tw * 0.5, by + (th - 12) * 0.5, [1, 1, 1, 1], {
      align: "center",
      maxWidth: tw - 16,
      outlined: false,
    });
  }

  /**
   * Authentic CA.exe Vertical Scrollbar (Etc/VScroll_BtUp, VScroll_BtDown, VScroll_Ball)!
   */
  public vScrollBar(
    assets: ClientAssetManager,
    id: string,
    x: number,
    y: number,
    h: number,
    offset: number,
    maxOffset: number,
    step = 1,
  ): number {
    let next = offset;
    if (
      this.spriteButton(assets, `${id}_up`, "Etc/VScroll_BtUp", x, y, {
        disabled: offset <= 0,
      })
    ) {
      next = Math.max(0, offset - step);
    }
    if (
      this.spriteButton(assets, `${id}_dn`, "Etc/VScroll_BtDown", x, y + h - 18, {
        disabled: offset >= maxOffset,
      })
    ) {
      next = Math.min(maxOffset, offset + step);
    }

    const trackTop = y + 18;
    const trackH = Math.max(18, h - 36);
    const ballH = 18;
    const ratio = maxOffset > 0 ? Math.max(0, Math.min(1, next / maxOffset)) : 0;
    const ballY = Math.round(trackTop + ratio * (trackH - ballH));

    const ballSheet = assets.getSpriteSync("Fx", "Etc/VScroll_Ball");
    if (ballSheet) {
      assets.drawSpriteFrame(ballSheet, 0, x + 1, ballY);
    }

    if (!this.hasNoticeOpen && this.mouseDown && this.isHovered(x, trackTop, 19, trackH)) {
      const clickRatio = Math.max(0, Math.min(1, (this.mouseY - trackTop - ballH * 0.5) / Math.max(1, trackH - ballH)));
      next = Math.round(clickRatio * maxOffset);
    }
    if (!this.hasNoticeOpen && this.wheelDelta !== 0) {
      next = Math.max(0, Math.min(maxOffset, next + this.wheelDelta * step));
      this.wheelDelta = 0;
    }

    return next;
  }

  /**
   * Native transparent text field rendered directly inside CA.exe's carved artwork input slots
   * (or inside native 9-slice Etc/TextBox when drawNineSliceBg is true).
   */
  public carvedField(
    id: string,
    x: number,
    y: number,
    w: number,
    h: number,
    opts?: {
      assets?: ClientAssetManager;
      placeholder?: string;
      password?: boolean;
      defaultValue?: string;
      textColor?: RGBA;
      placeholderColor?: RGBA;
      drawNineSliceBg?: boolean;
      outlined?: boolean;
      disabled?: boolean;
    },
  ): { value: string; submitted: boolean } {
    if (!this.fieldValues.has(id)) {
      this.fieldValues.set(id, opts?.defaultValue ?? "");
    }

    const locked = this.hasNoticeOpen || Boolean(opts?.disabled);
    const hovered = !locked && this.isHovered(x, y, w, h);
    if (hovered) this.currentFrameHoverId = `field:${id}`;

    if (!locked && this.mouseClicked) {
      if (hovered) {
        this.mouseClicked = false;
        this.focusField(id);
      } else if (this.activeFieldId === id) {
        this.blurField();
      }
    }

    const focused = !locked && this.activeFieldId === id;
    const rawVal = this.fieldValues.get(id) ?? "";
    const shown = opts?.password ? "*".repeat(rawVal.length) : rawVal;

    if (opts?.drawNineSliceBg && opts.assets) {
      this.drawNineSliceTextBox(opts.assets, x, y, w, h);
    }

    const ty = y + Math.max(0, Math.floor((h - 12) * 0.5));
    const textCol = opts?.textColor ?? [1, 1, 1, 1];
    const outlined = opts?.outlined ?? false;
    if (shown.length > 0) {
      const fullW = this.renderer.measureText(shown);
      const visibleText = fullW > w - 8 ? shown.slice(-Math.max(4, Math.floor((w - 8) / 7))) : shown;
      this.renderer.drawText(visibleText, x + 4, ty, textCol, {
        maxWidth: w - 6,
        outlined,
      });
      if (focused && Math.floor(performance.now() / 420) % 2 === 0) {
        const vw = this.renderer.measureText(visibleText);
        const cx = Math.min(x + w - 3, x + 5 + vw);
        this.renderer.drawRect(cx, ty, 1, 12, textCol);
      }
    } else {
      if (opts?.placeholder && !focused) {
        this.renderer.drawText(
          opts.placeholder,
          x + 4,
          ty,
          opts.placeholderColor ?? [0.62, 0.78, 0.96, 0.82],
          { maxWidth: w - 6, outlined: false },
        );
      }
      if (focused && Math.floor(performance.now() / 420) % 2 === 0) {
        this.renderer.drawRect(x + 4, ty, 1, 12, textCol);
      }
    }

    const submitted = !locked && this.submittedFieldId === id;
    return { value: rawVal, submitted };
  }

  /**
   * Renders top-most native CA.exe overlays:
   * 1. Etc/Dlg_Notice + Etc/BtOk (CNoticeDlg)
   * 2. GlobalUI/Glob_Tooltip (native 9-piece tooltip)
   * 3. Etc/Cursor (animated 5-frame game cursor)
   */
  public renderOverlays(assets: ClientAssetManager, animTick: number): void {
    // 1. Native CNoticeDlg (Etc/Dlg_Notice 320x252 + Etc/BtOk 102x30)
    if (this.noticeQueue.length > 0) {
      const msg = this.noticeQueue[0]!;
      // Native Etc/StageOpacity veil (solid black 10x10 tile, stretched + alpha-blended)
      if (
        !this.drawStretchedSprite(assets, "Etc/StageOpacity", 0, 0, SCREEN_WIDTH, SCREEN_HEIGHT, [
          1, 1, 1, 0.42,
        ])
      ) {
        this.renderer.drawRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT, [0, 0, 0, 0.42]);
      }
      const dx = 240;
      const dy = 174;
      const dlg = assets.getSpriteSync("Fx", "Etc/Dlg_Notice");
      if (dlg) {
        assets.drawSpriteFrame(dlg, 0, dx, dy);
      }

      // Word-wrap message neatly inside Etc/Dlg_Notice's dark content area (dx+28, dy+76, 264x104)
      const maxChars = 19;
      const lines: string[] = [];
      for (let i = 0; i < msg.length; i += maxChars) {
        lines.push(msg.slice(i, i + maxChars));
      }
      const startY = dy + 118 - Math.floor(((lines.length - 1) * 18) * 0.5);
      lines.slice(0, 5).forEach((ln, idx) => {
        this.renderer.drawText(ln, dx + 160, startY + idx * 18, [1, 1, 1, 1], {
          align: "center",
          maxWidth: 260,
          outlined: true,
        });
      });

      if (
        this.spriteButton(assets, "notice_ok", "Etc/BtOk", dx + 109, dy + 202, {
          ignoreNoticeLock: true,
        }) ||
        this.keysJustPressed.has("Enter") ||
        this.keysJustPressed.has("Escape") ||
        this.keysJustPressed.has("Space")
      ) {
        this.keysJustPressed.delete("Enter");
        this.keysJustPressed.delete("Escape");
        this.keysJustPressed.delete("Space");
        this.noticeQueue.shift();
      }
    }

    // 2. Native GlobalUI/Glob_Tooltip (f0..f7 border + f8 pointer tail)
    if (this.pendingTooltip) {
      const text = this.pendingTooltip.text;
      const tw = Math.max(36, this.renderer.measureText(text) + 18);
      const th = 22;
      const tx = Math.round(Math.max(4, Math.min(SCREEN_WIDTH - tw - 4, this.pendingTooltip.x - tw * 0.5)));
      const ty = Math.round(Math.max(4, this.pendingTooltip.y));

      const ttSheet = assets.getSpriteSync("Fx", "GlobalUI/Glob_ToolTip");
      if (ttSheet && ttSheet.frames.length >= 8) {
        // The native Glob_ToolTip border pieces are solid RGB(0, 55, 119) and the sheet
        // has no centre piece, so the interior is filled with that exact colour.
        this.renderer.drawRect(tx + 3, ty + 3, tw - 6, th - 6, [0, 55 / 255, 119 / 255, 1]);
        const cw = Math.min(15, Math.floor(tw * 0.5));
        const ch = 5;
        const iw = Math.max(1, tw - cw * 2);
        const ih = Math.max(1, th - ch * 2);
        drawSheetFrameStretched(this.renderer, ttSheet, 0, tx, ty, cw, ch);
        drawSheetFrameStretched(this.renderer, ttSheet, 1, tx + cw, ty, iw, ch);
        drawSheetFrameStretched(this.renderer, ttSheet, 2, tx + tw - cw, ty, cw, ch);
        drawSheetFrameStretched(this.renderer, ttSheet, 3, tx, ty + ch, cw, ih);
        drawSheetFrameStretched(this.renderer, ttSheet, 4, tx + tw - cw, ty + ch, cw, ih);
        drawSheetFrameStretched(this.renderer, ttSheet, 5, tx, ty + th - ch, cw, ch);
        drawSheetFrameStretched(this.renderer, ttSheet, 6, tx + cw, ty + th - ch, iw, ch);
        drawSheetFrameStretched(this.renderer, ttSheet, 7, tx + tw - cw, ty + th - ch, cw, ch);
        if (ttSheet.frames.length >= 9) {
          const arrowX = Math.max(tx + 6, Math.min(tx + tw - 15, Math.round(this.pendingTooltip.x - 4)));
          assets.drawSpriteFrame(ttSheet, 8, arrowX, ty + th - 2);
        }
      } else {
        this.drawNineSliceTextBox(assets, tx, ty, tw, th);
      }

      this.renderer.drawText(text, tx + tw * 0.5, ty + 5, [1, 1, 1, 1], {
        align: "center",
        outlined: false,
      });
    }

    // 3. Native Animated Etc/Cursor (5 frames, 33x36)
    const curSheet = assets.getSpriteSync("Fx", "Etc/Cursor");
    if (curSheet && curSheet.frames.length > 0) {
      let cFrame = 0;
      if (this.mouseDown && curSheet.frames.length >= 5) {
        cFrame = 4;
      } else if (this.currentFrameHoverId && curSheet.frames.length >= 4) {
        cFrame = 1 + (Math.floor(animTick / 6) % 3);
      }
      assets.drawSpriteFrame(curSheet, cFrame, Math.round(this.mouseX), Math.round(this.mouseY));
    }
  }
}
