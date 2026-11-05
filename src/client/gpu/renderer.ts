import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../shared/constants.ts";
import type { FftFont } from "../../shared/formats/fft.ts";

const SHADER_WGSL = /* wgsl */ `
struct Globals {
  screenSize: vec2<f32>,
  _pad: vec2<f32>,
};

@group(0) @binding(0) var<uniform> globals: Globals;
@group(0) @binding(1) var samp: sampler;
@group(1) @binding(0) var tex: texture_2d<f32>;

struct VertexInput {
  @location(0) pos: vec2<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) color: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) color: vec4<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  let ndcX = (in.pos.x / globals.screenSize.x) * 2.0 - 1.0;
  let ndcY = 1.0 - (in.pos.y / globals.screenSize.y) * 2.0;
  out.clipPos = vec4<f32>(ndcX, ndcY, 0.0, 1.0);
  out.uv = in.uv;
  out.color = in.color;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let texel = textureSample(tex, samp, in.uv);
  let outColor = texel * in.color;
  if (outColor.a < 0.004) {
    discard;
  }
  return outColor;
}
`;

export type RGBA = readonly [number, number, number, number];

export interface GpuTextureHandle {
  id: number;
  width: number;
  height: number;
  texture: GPUTexture;
  bindGroup: GPUBindGroup;
}

interface BatchDrawCmd {
  tex: GpuTextureHandle;
  additive: boolean;
  firstVertex: number;
  vertexCount: number;
}

interface AtlasGlyphSlot {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  w: number;
  h: number;
  advance: number;
}

const MAX_QUADS_PER_FRAME = 16384;
const FLOATS_PER_VERTEX = 8; // x, y, u, v, r, g, b, a
const VERTICES_PER_QUAD = 6;

export class WebGpuRenderer {
  public readonly canvas: HTMLCanvasElement;
  public readonly device: GPUDevice;
  public readonly context: GPUCanvasContext;
  public readonly format: GPUTextureFormat;

  private readonly globalBuffer: GPUBuffer;
  private readonly globalBindGroup: GPUBindGroup;
  private readonly texBindGroupLayout: GPUBindGroupLayout;
  private readonly alphaPipeline: GPURenderPipeline;
  private readonly additivePipeline: GPURenderPipeline;
  private readonly vertexBuffer: GPUBuffer;
  private readonly vertexData: Float32Array;

  public readonly whiteTex: GpuTextureHandle;

  // Dynamic 1024x1024 .fft bitmap font glyph atlas (pure WebGPU writeTexture!)
  private readonly glyphAtlasTex: GpuTextureHandle;
  private readonly glyphCache = new Map<number, AtlasGlyphSlot>();
  private atlasCursorX = 1;
  private atlasCursorY = 1;
  private atlasRowH = 0;

  private fontUni: FftFont | null = null;
  private fontBold: FftFont | null = null;

  private nextTexId = 1;
  private quadCount = 0;
  private batches: BatchDrawCmd[] = [];

  private constructor(
    canvas: HTMLCanvasElement,
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
  ) {
    this.canvas = canvas;
    this.device = device;
    this.context = context;
    this.format = format;

    const module = device.createShaderModule({ code: SHADER_WGSL });

    const globalBindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });

    this.texBindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [globalBindGroupLayout, this.texBindGroupLayout],
    });

    const vertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: FLOATS_PER_VERTEX * 4,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x2" },
        { shaderLocation: 1, offset: 8, format: "float32x2" },
        { shaderLocation: 2, offset: 16, format: "float32x4" },
      ],
    };

    this.alphaPipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: "vs_main", buffers: [vertexBufferLayout] },
      fragment: {
        module,
        entryPoint: "fs_main",
        targets: [
          {
            format,
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    });

    this.additivePipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: "vs_main", buffers: [vertexBufferLayout] },
      fragment: {
        module,
        entryPoint: "fs_main",
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    });

    this.globalBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(
      this.globalBuffer,
      0,
      new Float32Array([SCREEN_WIDTH, SCREEN_HEIGHT, 0, 0]),
    );

    const nearestSampler = device.createSampler({
      magFilter: "nearest",
      minFilter: "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.globalBindGroup = device.createBindGroup({
      layout: globalBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.globalBuffer } },
        { binding: 1, resource: nearestSampler },
      ],
    });

    this.vertexData = new Float32Array(
      MAX_QUADS_PER_FRAME * VERTICES_PER_QUAD * FLOATS_PER_VERTEX,
    );
    this.vertexBuffer = device.createBuffer({
      size: this.vertexData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    this.whiteTex = this.createTextureFromRGBA(1, 1, new Uint8Array([255, 255, 255, 255]));
    this.glyphAtlasTex = this.createTextureFromRGBA(
      1024,
      1024,
      new Uint8Array(1024 * 1024 * 4),
    );
  }

  public static async init(canvas: HTMLCanvasElement): Promise<WebGpuRenderer> {
    if (!navigator.gpu) {
      throw new Error("您的瀏覽器未啟用 WebGPU 支援（本專案採用純 WebGPU 800×600 硬體渲染，零 Canvas2D 後備）。請使用支援 WebGPU 的現代瀏覽器開啟！");
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error("無法取得 WebGPU 硬體顯示卡配接器 (GPUAdapter)。");
    }
    const device = await adapter.requestDevice();
    canvas.width = SCREEN_WIDTH;
    canvas.height = SCREEN_HEIGHT;

    const context = canvas.getContext("webgpu");
    if (!context) {
      throw new Error("無法建立 WebGPU Canvas Context。");
    }
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
      device,
      format,
      alphaMode: "opaque",
    });

    return new WebGpuRenderer(canvas, device, context, format);
  }

  public setFonts(uni: FftFont, bold?: FftFont): void {
    this.fontUni = uni;
    this.fontBold = bold ?? uni;
  }

  public createTextureFromRGBA(width: number, height: number, rgba: Uint8Array): GpuTextureHandle {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const texture = this.device.createTexture({
      size: { width: w, height: h, depthOrArrayLayers: 1 },
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });

    this.device.queue.writeTexture(
      { texture },
      rgba as unknown as BufferSource,
      { bytesPerRow: w * 4, rowsPerImage: h },
      { width: w, height: h, depthOrArrayLayers: 1 },
    );

    const bindGroup = this.device.createBindGroup({
      layout: this.texBindGroupLayout,
      entries: [{ binding: 0, resource: texture.createView() }],
    });

    return {
      id: this.nextTexId++,
      width: w,
      height: h,
      texture,
      bindGroup,
    };
  }

  public async createTextureFromImageBytes(bytes: Uint8Array, mime = "image/jpeg"): Promise<GpuTextureHandle> {
    const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
    const bmp = await createImageBitmap(blob);
    const w = bmp.width;
    const h = bmp.height;

    const texture = this.device.createTexture({
      size: { width: w, height: h, depthOrArrayLayers: 1 },
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });

    this.device.queue.copyExternalImageToTexture(
      { source: bmp },
      { texture },
      { width: w, height: h },
    );
    bmp.close();

    const bindGroup = this.device.createBindGroup({
      layout: this.texBindGroupLayout,
      entries: [{ binding: 0, resource: texture.createView() }],
    });

    return {
      id: this.nextTexId++,
      width: w,
      height: h,
      texture,
      bindGroup,
    };
  }

  public beginFrame(): void {
    this.quadCount = 0;
    this.batches.length = 0;
  }

  public drawQuad(
    tex: GpuTextureHandle,
    x: number,
    y: number,
    w: number,
    h: number,
    u0 = 0,
    v0 = 0,
    u1 = 1,
    v1 = 1,
    color: RGBA = [1, 1, 1, 1],
    additive = false,
  ): void {
    if (this.quadCount >= MAX_QUADS_PER_FRAME || w <= 0 || h <= 0 || color[3] <= 0) return;

    const firstVertex = this.quadCount * VERTICES_PER_QUAD;
    let base = firstVertex * FLOATS_PER_VERTEX;
    const x0 = Math.round(x);
    const y0 = Math.round(y);
    const x1 = Math.round(x + w);
    const y1 = Math.round(y + h);
    const [r, g, b, a] = color;

    const writeV = (px: number, py: number, pu: number, pv: number) => {
      this.vertexData[base++] = px;
      this.vertexData[base++] = py;
      this.vertexData[base++] = pu;
      this.vertexData[base++] = pv;
      this.vertexData[base++] = r;
      this.vertexData[base++] = g;
      this.vertexData[base++] = b;
      this.vertexData[base++] = a;
    };

    // Two triangles: (x0,y0)-(x1,y0)-(x0,y1) and (x0,y1)-(x1,y0)-(x1,y1)
    writeV(x0, y0, u0, v0);
    writeV(x1, y0, u1, v0);
    writeV(x0, y1, u0, v1);

    writeV(x0, y1, u0, v1);
    writeV(x1, y0, u1, v0);
    writeV(x1, y1, u1, v1);

    this.quadCount++;

    const prev = this.batches[this.batches.length - 1];
    if (prev && prev.tex.id === tex.id && prev.additive === additive) {
      prev.vertexCount += VERTICES_PER_QUAD;
    } else {
      this.batches.push({
        tex,
        additive,
        firstVertex,
        vertexCount: VERTICES_PER_QUAD,
      });
    }
  }

  public drawRect(x: number, y: number, w: number, h: number, color: RGBA): void {
    this.drawQuad(this.whiteTex, x, y, w, h, 0, 0, 1, 1, color, false);
  }

  private getOrUploadGlyph(cp: number, outlined: boolean, bold: boolean): AtlasGlyphSlot | null {
    const font = bold && this.fontBold ? this.fontBold : this.fontUni;
    if (!font) return null;

    const key = (cp & 0xffff) | (outlined ? 0x10000 : 0) | (bold ? 0x20000 : 0);
    const cached = this.glyphCache.get(key);
    if (cached) return cached;

    const g = font.decodeGlyph(cp, outlined, [255, 255, 255], [10, 16, 28]);
    if (this.atlasCursorX + g.width + 1 >= 1024) {
      this.atlasCursorX = 1;
      this.atlasCursorY += this.atlasRowH + 1;
      this.atlasRowH = 0;
    }
    if (this.atlasCursorY + g.height + 1 >= 1024) {
      // Wrap around if atlas ever fills
      this.glyphCache.clear();
      this.atlasCursorX = 1;
      this.atlasCursorY = 1;
      this.atlasRowH = 0;
    }

    const gx = this.atlasCursorX;
    const gy = this.atlasCursorY;
    this.atlasCursorX += g.width + 1;
    this.atlasRowH = Math.max(this.atlasRowH, g.height);

    if (cp > 0x20) {
      this.device.queue.writeTexture(
        { texture: this.glyphAtlasTex.texture, origin: { x: gx, y: gy, z: 0 } },
        g.rgba as unknown as BufferSource,
        { bytesPerRow: g.width * 4, rowsPerImage: g.height },
        { width: g.width, height: g.height, depthOrArrayLayers: 1 },
      );
    }

    const slot: AtlasGlyphSlot = {
      u0: gx / 1024,
      v0: gy / 1024,
      u1: (gx + g.width) / 1024,
      v1: (gy + g.height) / 1024,
      w: g.width,
      h: g.height,
      advance: g.advance,
    };
    this.glyphCache.set(key, slot);
    return slot;
  }

  public measureText(text: string, outlined = true, scale = 1): number {
    if (!this.fontUni) return text.length * 12 * scale;
    return this.fontUni.measureText(text, outlined) * scale;
  }

  public drawText(
    text: string,
    x: number,
    y: number,
    color: RGBA = [1, 1, 1, 1],
    opts?: {
      outlined?: boolean;
      bold?: boolean;
      align?: "left" | "center" | "right";
      scale?: number;
      maxWidth?: number;
    },
  ): number {
    if (!text || !this.fontUni) return 0;
    const outlined = opts?.outlined ?? true;
    const bold = opts?.bold ?? false;
    const scale = opts?.scale ?? 1;
    const align = opts?.align ?? "left";

    const totalW = this.measureText(text, outlined, scale);
    let drawX = x;
    if (align === "center") drawX = Math.round(x - totalW * 0.5);
    else if (align === "right") drawX = Math.round(x - totalW);

    const startX = drawX;
    for (let i = 0; i < text.length; i++) {
      const cp = text.charCodeAt(i);
      if (cp === 0x0a || cp === 0x0d) continue;
      const slot = this.getOrUploadGlyph(cp, outlined, bold);
      if (!slot) continue;
      if (opts?.maxWidth && drawX + slot.advance * scale - startX > opts.maxWidth) {
        break;
      }
      if (cp > 0x20) {
        this.drawQuad(
          this.glyphAtlasTex,
          drawX,
          y,
          slot.w * scale,
          slot.h * scale,
          slot.u0,
          slot.v0,
          slot.u1,
          slot.v1,
          color,
          false,
        );
      }
      drawX += slot.advance * scale;
    }
    return drawX - startX;
  }

  public endFrame(clearColor: RGBA = [0.04, 0.09, 0.18, 1]): void {
    if (this.quadCount > 0) {
      const byteLen = this.quadCount * VERTICES_PER_QUAD * FLOATS_PER_VERTEX * 4;
      this.device.queue.writeBuffer(
        this.vertexBuffer,
        0,
        this.vertexData.buffer,
        0,
        byteLen,
      );
    }

    const encoder = this.device.createCommandEncoder();
    const view = this.context.getCurrentTexture().createView();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          clearValue: {
            r: clearColor[0],
            g: clearColor[1],
            b: clearColor[2],
            a: clearColor[3],
          },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });

    if (this.quadCount > 0) {
      pass.setBindGroup(0, this.globalBindGroup);
      pass.setVertexBuffer(0, this.vertexBuffer);

      let curAdditive: boolean | null = null;
      for (const batch of this.batches) {
        if (curAdditive !== batch.additive) {
          curAdditive = batch.additive;
          pass.setPipeline(batch.additive ? this.additivePipeline : this.alphaPipeline);
        }
        pass.setBindGroup(1, batch.tex.bindGroup);
        pass.draw(batch.vertexCount, 1, batch.firstVertex, 0);
      }
    }

    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
}
