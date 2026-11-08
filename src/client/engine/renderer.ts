/**
 * 2D sprite renderer faithful to the original DDraw/D3D blit model at 800x600.
 * Primary backend: WebGPU (batched textured quads, straight-alpha blending).
 * Fallback: Canvas2D (identical drawImage semantics) so the client always runs.
 */
import type { Sprite } from "./assets.ts";
import { SCREEN_W, SCREEN_H, type Rect } from "./types.ts";

export interface DrawOptions {
  src?: Rect;
  alpha?: number;
  flipX?: boolean;
  flipY?: boolean;
}

export interface Renderer {
  readonly kind: "webgpu" | "canvas2d";
  readonly canvas: HTMLCanvasElement;
  begin(clear?: [number, number, number, number]): void;
  draw(sprite: Sprite, dst: Rect, opts?: DrawOptions): void;
  end(): void;
}

/* ----------------------------- Canvas2D backend ---------------------------- */

class Canvas2DRenderer implements Renderer {
  readonly kind = "canvas2d" as const;
  private ctx: CanvasRenderingContext2D;
  constructor(readonly canvas: HTMLCanvasElement) {
    canvas.width = SCREEN_W;
    canvas.height = SCREEN_H;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("no 2d context");
    this.ctx = ctx;
    ctx.imageSmoothingEnabled = false;
  }
  begin(clear: [number, number, number, number] = [0, 0, 0, 1]) {
    const c = this.ctx;
    c.globalAlpha = 1;
    c.fillStyle = `rgb(${clear[0] * 255},${clear[1] * 255},${clear[2] * 255})`;
    c.fillRect(0, 0, SCREEN_W, SCREEN_H);
  }
  draw(sprite: Sprite, dst: Rect, opts: DrawOptions = {}) {
    const c = this.ctx;
    const src = opts.src ?? sprite.frames[0] ?? { x: 0, y: 0, w: sprite.w, h: sprite.h };
    c.globalAlpha = opts.alpha ?? 1;
    if (opts.flipX || opts.flipY) {
      c.save();
      c.translate(dst.x + (opts.flipX ? dst.w : 0), dst.y + (opts.flipY ? dst.h : 0));
      c.scale(opts.flipX ? -1 : 1, opts.flipY ? -1 : 1);
      c.drawImage(sprite.bitmap, src.x, src.y, src.w, src.h, 0, 0, dst.w, dst.h);
      c.restore();
    } else {
      c.drawImage(sprite.bitmap, src.x, src.y, src.w, src.h, dst.x, dst.y, dst.w, dst.h);
    }
    c.globalAlpha = 1;
  }
  end() {
    /* immediate mode */
  }
}

/* ------------------------------ WebGPU backend ----------------------------- */

const FLOATS_PER_VERTEX = 8; // pos2 uv2 color4
const VERTS_PER_QUAD = 6;
const MAX_QUADS = 8192;

const WGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
};
@vertex fn vs(@location(0) pos: vec2f, @location(1) uv: vec2f, @location(2) color: vec4f) -> VSOut {
  var o: VSOut;
  o.pos = vec4f(pos.x / ${SCREEN_W}.0 * 2.0 - 1.0, 1.0 - pos.y / ${SCREEN_H}.0 * 2.0, 0.0, 1.0);
  o.uv = uv;
  o.color = color;
  return o;
}
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@fragment fn fs(o: VSOut) -> @location(0) vec4f {
  return textureSample(tex, samp, o.uv) * o.color;
}
`;

class WebGPURenderer implements Renderer {
  readonly kind = "webgpu" as const;
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private pipeline!: GPURenderPipeline;
  private sampler!: GPUSampler;
  private bindLayout!: GPUBindGroupLayout;
  private vertexBuffer!: GPUBuffer;
  private texCache = new Map<string, { tex: GPUTexture; bind: GPUBindGroup; w: number; h: number }>();
  private uploadCanvas: HTMLCanvasElement | null = null;
  private uploadCtx: CanvasRenderingContext2D | null = null;
  private verts = new Float32Array(MAX_QUADS * VERTS_PER_QUAD * FLOATS_PER_VERTEX);
  private quadCount = 0;
  private curTex: string | null = null;
  private batches: Array<{ url: string; firstQuad: number; count: number }> = [];
  private clear: [number, number, number, number] = [0, 0, 0, 1];

  private constructor(readonly canvas: HTMLCanvasElement) {}

  static async create(canvas: HTMLCanvasElement): Promise<WebGPURenderer> {
    if (!navigator.gpu) throw new Error("no WebGPU");
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("no adapter");
    const r = new WebGPURenderer(canvas);
    r.device = await adapter.requestDevice();
    canvas.width = SCREEN_W;
    canvas.height = SCREEN_H;
    const ctx = canvas.getContext("webgpu") as GPUCanvasContext | null;
    if (!ctx) throw new Error("no webgpu context");
    r.context = ctx;
    const format = navigator.gpu.getPreferredCanvasFormat();
    r.context.configure({ device: r.device, format, alphaMode: "opaque" });
    r.sampler = r.device.createSampler({ magFilter: "nearest", minFilter: "nearest" });
    r.bindLayout = r.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    const module = r.device.createShaderModule({ code: WGSL });
    r.pipeline = r.device.createRenderPipeline({
      layout: r.device.createPipelineLayout({ bindGroupLayouts: [r.bindLayout] }),
      vertex: {
        module,
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: FLOATS_PER_VERTEX * 4,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x2" },
              { shaderLocation: 1, offset: 8, format: "float32x2" },
              { shaderLocation: 2, offset: 16, format: "float32x4" },
            ],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: "fs",
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    });
    r.vertexBuffer = r.device.createBuffer({
      size: r.verts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    return r;
  }

  private readPixels(source: CanvasImageSource, w: number, h: number): Uint8ClampedArray {
    if (!this.uploadCanvas) {
      this.uploadCanvas = document.createElement("canvas");
      this.uploadCtx = this.uploadCanvas.getContext("2d", { willReadFrequently: true });
    }
    if (!this.uploadCtx) throw new Error("no 2d context for texture upload");
    if (this.uploadCanvas!.width !== w) this.uploadCanvas!.width = w;
    if (this.uploadCanvas!.height !== h) this.uploadCanvas!.height = h;
    this.uploadCtx.clearRect(0, 0, w, h);
    this.uploadCtx.drawImage(source, 0, 0);
    return this.uploadCtx.getImageData(0, 0, w, h).data;
  }

  private texture(sprite: Sprite) {
    let e = this.texCache.get(sprite.url);
    if (!e) {
      const tex = this.device.createTexture({
        size: [sprite.bitmap.width, sprite.bitmap.height],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      const w = sprite.bitmap.width, h = sprite.bitmap.height;
      try {
        // Upload via writeTexture instead of copyExternalImageToTexture: some
        // adapters (notably headless SwiftShader) drop external ImageBitmap/JPEG
        // references after a few copies. Bitmap-font sprites are sync canvases,
        // so a single 2D readback path covers both assets and text reliably.
        const pixels = this.readPixels(sprite.bitmap as unknown as CanvasImageSource, w, h);
        const bytesPerRow = Math.ceil(w * 4 / 256) * 256;
        const padded = new Uint8Array(bytesPerRow * h);
        for (let y = 0; y < h; y++) padded.set(pixels.subarray(y * w * 4, (y + 1) * w * 4), y * bytesPerRow);
        this.device.queue.writeTexture({ texture: tex }, padded, { bytesPerRow, rowsPerImage: h }, [w, h]);
      } catch (e) {
        throw new Error(`WebGPU texture upload failed for ${sprite.url} (${w}x${h}): ${(e as Error).message}`);
      }
      const bind = this.device.createBindGroup({
        layout: this.bindLayout,
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: tex.createView() },
        ],
      });
      e = { tex, bind, w: sprite.bitmap.width, h: sprite.bitmap.height };
      this.texCache.set(sprite.url, e);
    }
    return e;
  }

  begin(clear: [number, number, number, number] = [0, 0, 0, 1]) {
    this.clear = clear;
    this.quadCount = 0;
    this.curTex = null;
    this.batches.length = 0;
  }

  draw(sprite: Sprite, dst: Rect, opts: DrawOptions = {}) {
    if (this.quadCount >= MAX_QUADS) return; // overflow guard
    if (this.curTex !== sprite.url) {
      this.curTex = sprite.url;
      this.batches.push({ url: sprite.url, firstQuad: this.quadCount, count: 0 });
    }
    this.texture(sprite); // ensure uploaded
    const batch = this.batches[this.batches.length - 1]!;
    const t = this.texCache.get(sprite.url)!;
    const src = opts.src ?? sprite.frames[0] ?? { x: 0, y: 0, w: sprite.w, h: sprite.h };
    let u0 = src.x / t.w, v0 = src.y / t.h, u1 = (src.x + src.w) / t.w, v1 = (src.y + src.h) / t.h;
    if (opts.flipX) [u0, u1] = [u1, u0];
    if (opts.flipY) [v0, v1] = [v1, v0];
    const a = opts.alpha ?? 1;
    const x0 = dst.x, y0 = dst.y, x1 = dst.x + dst.w, y1 = dst.y + dst.h;
    const base = this.quadCount * VERTS_PER_QUAD * FLOATS_PER_VERTEX;
    const v = this.verts;
    const put = (i: number, x: number, y: number, u: number, vv: number) => {
      const o = base + i * FLOATS_PER_VERTEX;
      v[o] = x; v[o + 1] = y; v[o + 2] = u; v[o + 3] = vv;
      v[o + 4] = 1; v[o + 5] = 1; v[o + 6] = 1; v[o + 7] = a;
    };
    put(0, x0, y0, u0, v0);
    put(1, x1, y0, u1, v0);
    put(2, x0, y1, u0, v1);
    put(3, x1, y0, u1, v0);
    put(4, x1, y1, u1, v1);
    put(5, x0, y1, u0, v1);
    this.quadCount++;
    batch.count++;
  }

  end() {
    const encoder = this.device.createCommandEncoder();
    const view = this.context.getCurrentTexture().createView();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          clearValue: { r: this.clear[0], g: this.clear[1], b: this.clear[2], a: this.clear[3] },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    if (this.quadCount > 0) {
      const data = this.verts.subarray(0, this.quadCount * VERTS_PER_QUAD * FLOATS_PER_VERTEX);
      this.device.queue.writeBuffer(this.vertexBuffer, 0, data);
      pass.setPipeline(this.pipeline);
      pass.setVertexBuffer(0, this.vertexBuffer);
      for (const b of this.batches) {
        if (b.count === 0) continue;
        const e = this.texCache.get(b.url)!;
        pass.setBindGroup(0, e.bind);
        pass.draw(b.count * VERTS_PER_QUAD, 1, b.firstQuad * VERTS_PER_QUAD, 0);
      }
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    this.curTex = null;
  }
}

/** Create the best available renderer (WebGPU preferred, Canvas2D fallback). */
export async function createRenderer(canvas: HTMLCanvasElement): Promise<Renderer> {
  try {
    return await WebGPURenderer.create(canvas);
  } catch (e) {
    console.warn("[renderer] WebGPU unavailable, falling back to Canvas2D:", (e as Error).message);
    return new Canvas2DRenderer(canvas);
  }
}