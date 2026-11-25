import type { Project as PixelProject } from '@pixel/core/project';
import { parseProject } from '@pixel/io/project';
import type { PixelSource, SoundSource } from '../core/level';
import { starterAssets } from '../core/starter';
import { PIXEL_AUTOSAVE_KEY, PIXEL_DB, SOUND_DB, dbExists, kvGet } from './storage';
import { readZip } from './unzip';

/** Resolve a level's Pixel source to a full HiROM Pixel project (tiles, CGRAM, sprites). */
export async function loadPixelSource(src: PixelSource): Promise<PixelProject | null> {
  if (src.kind === 'builtin') return starterAssets().project;
  if (src.kind === 'file') return src.json ? parseProject(src.json) : null;
  if (!(await dbExists(PIXEL_DB))) return null;
  const data = await kvGet<unknown>(PIXEL_DB, PIXEL_AUTOSAVE_KEY);
  return data ? parseProject(data) : null;
}

/** What HiROM Sound's engine needs for one sample. */
export interface EngineSample {
  brr: Uint8Array;
  loop: boolean;
  loopBlock: number;
  rate: number;
  baseNote: number;
  fineTune: number;
}

export interface SoundTrack {
  id: string;
  name: string;
  /** HiROM Sound project object (as stored by HiROM Sound). */
  project: { meta?: { title?: string }; samples?: { id: string; sampleRate?: number; baseNote?: number; fineTune?: number; loopEnabled?: boolean; loopStartBlock?: number }[] };
  samples: Map<string, EngineSample>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** Load a HiROM Sound project: the live one from HiROM Sound's storage, or an imported .hiromsound. */
export async function loadSoundTrack(src: SoundSource, fileBytes?: Uint8Array): Promise<SoundTrack | null> {
  if (src.kind === 'live') {
    if (!(await dbExists(SOUND_DB))) return null;
    const project = await kvGet<Json>(SOUND_DB, 'project');
    if (!project) return null;
    const samples = new Map<string, EngineSample>();
    for (const s of project.samples ?? []) {
      const enc = await kvGet<Json>(SOUND_DB, 'enc:' + s.id);
      if (!enc?.brr) continue;
      samples.set(s.id, {
        brr: enc.brr,
        loop: !!enc.loop,
        loopBlock: enc.loopBlock | 0,
        rate: s.sampleRate || enc.rate || 32000,
        baseNote: s.baseNote ?? 60,
        fineTune: s.fineTune || 0,
      });
    }
    return { id: src.id, name: project.meta?.title ?? src.name, project, samples };
  }
  if (!fileBytes) return null;
  return parseSoundFile(src.id, src.name, fileBytes);
}

/** Read a .hiromsound / .snesproj bundle (zip of project.json + samples/*.brr). */
export async function parseSoundFile(id: string, name: string, bytes: Uint8Array): Promise<SoundTrack> {
  const zip = readZip(bytes);
  const pj = zip.get('project.json');
  if (!pj) throw new Error('This isn’t a HiROM Sound project (no project.json inside).');
  const project = JSON.parse(new TextDecoder().decode(await pj.read()));
  const samples = new Map<string, EngineSample>();
  for (const s of project.samples ?? []) {
    const entry = zip.get(s.brrFile ?? `samples/${s.id}.brr`);
    if (!entry) continue;
    samples.set(s.id, {
      brr: await entry.read(),
      loop: !!s.loopEnabled,
      loopBlock: s.loopStartBlock | 0,
      rate: s.sampleRate || 32000,
      baseNote: s.baseNote ?? 60,
      fineTune: s.fineTune || 0,
    });
  }
  return { id, name: project.meta?.title ?? name, project, samples };
}

/** HiROM Sound's audio engine, loaded at runtime from the Sound app so playtest uses the real S-DSP. */
export interface SoundEngine {
  start(): Promise<void>;
  setSong(song: unknown): void;
  setSample(id: string, s: EngineSample | null): void;
  play(opts: { mode: 'song'; order?: number; row?: number; loop?: boolean }): void;
  stop(): void;
  panic(): void;
  ctx: AudioContext | null;
}

let enginePromise: Promise<SoundEngine> | null = null;

export function loadSoundEngine(): Promise<SoundEngine> {
  if (!enginePromise) {
    const url = new URL('../sound/js/audio.js', document.baseURI).href;
    enginePromise = import(/* @vite-ignore */ url).then((m: { Audio: new () => SoundEngine }) => new m.Audio());
    enginePromise.catch(() => (enginePromise = null));
  }
  return enginePromise;
}
