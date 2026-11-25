import type { MapEditor } from '../core/editor';
import { refId } from '../core/level';
import { loadSoundEngine, loadSoundTrack, type SoundEngine, type SoundTrack } from './sources';

/**
 * Plays HiROM Sound projects through HiROM Sound's own S-DSP engine (loaded at runtime), switching
 * tracks as the playtest crosses music zones.
 */
export class MusicPlayer {
  private engine: SoundEngine | null = null;
  private current: string | null = null;
  private tracks = new Map<string, SoundTrack | null>();
  private token = 0;
  status = '';

  constructor(private ed: MapEditor) {
    ed.soundChanged = () => this.tracks.clear();
  }

  /** Call from a click handler so the browser lets audio start. */
  async warmUp(): Promise<void> {
    try {
      this.engine ??= await loadSoundEngine();
      await this.engine.start();
    } catch (e) {
      this.status = `Couldn't start HiROM Sound's engine: ${e instanceof Error ? e.message : e}`;
    }
  }

  async play(ref: string | null): Promise<void> {
    if (ref === this.current) return;
    this.current = ref;
    const my = ++this.token;
    if (!ref) {
      this.engine?.stop();
      this.status = 'No music';
      return;
    }
    const id = refId(ref)!;
    const src = this.ed.ws.soundSources.find((s) => s.id === id);
    if (!src) {
      this.status = `Unknown track ${ref}`;
      return;
    }
    let track = this.tracks.get(id);
    if (track === undefined) {
      try {
        track = await loadSoundTrack(src, this.ed.soundFiles.get(id));
      } catch (e) {
        this.status = `Couldn't load "${src.name}": ${e instanceof Error ? e.message : e}`;
        return;
      }
      this.tracks.set(id, track);
    }
    if (my !== this.token) return;
    if (!track) {
      this.engine?.stop();
      this.status = src.kind === 'live' ? 'HiROM Sound has no saved project yet, so the level is silent.' : `"${src.name}" is empty.`;
      return;
    }
    try {
      this.engine ??= await loadSoundEngine();
      await this.engine.start();
      if (my !== this.token) return;
      this.engine.stop();
      for (const [sid, s] of track.samples) this.engine.setSample(sid, s);
      this.engine.setSong(track.project);
      this.engine.play({ mode: 'song', order: 0, row: 0, loop: true });
      this.status = `♪ ${track.name}`;
    } catch (e) {
      this.status = `Couldn't play music: ${e instanceof Error ? e.message : e}`;
    }
  }

  stop(): void {
    this.token++;
    this.current = null;
    this.engine?.stop();
  }
}
