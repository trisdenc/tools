import { Bpp } from './cgram';

/**
 * Indexed artwork. Each byte is a *local* palette index (0 .. 2^bpp - 1); the sub-palette is
 * chosen separately at render time, which is what makes palette swaps free.
 */
export interface IndexedImage {
  width: number;
  height: number;
  bpp: Bpp;
  pixels: Uint8Array;
}

export const MAX_DIMENSION = 1024;

export function createImage(width: number, height: number, bpp: Bpp): IndexedImage {
  return { width, height, bpp, pixels: new Uint8Array(width * height) };
}

export const inBounds = (img: IndexedImage, x: number, y: number): boolean =>
  x >= 0 && y >= 0 && x < img.width && y < img.height;
