import type { Project as PixelProject, SceneObject } from '@pixel/core/project';
import type { Level, Workspace, Zone } from './level';
import { levelPixels, refId, resolveEntity } from './level';
import { createBody, followCamera, stepPlatformer, stepTopDown, worldOf, type Body, type Input, type World } from './physics';

/**
 * Live playtest: a dummy character (or a free camera) dropped into the level. The camera follows
 * the player, clamps to camera-lock zones, and zones can switch music or fire trigger events.
 */
export class Playtest {
  body: Body;
  cam = { x: 0, y: 0 };
  tick = 0;
  keys = new Set<string>();
  private jumpWas = false;
  private world: World;
  private spawn: { x: number; y: number };
  private inside = new Set<string>();
  private musicStack: string[] = [];
  message: { text: string; until: number } | null = null;
  deaths = 0;

  constructor(
    private level: Level,
    private ws: Workspace,
    start?: { x: number; y: number },
  ) {
    this.world = worldOf(level, ws.materials);
    const spawnEnt = level.entities.find((e) => resolveEntity(e, ws.templates).type === 'player_spawn');
    const mode = level.playtest.mode;
    const w = mode === 'topdown' ? 12 : 12, h = mode === 'topdown' ? 12 : 22;
    const anchor = start ?? (spawnEnt ? { x: spawnEnt.x, y: spawnEnt.y } : { x: 64, y: 64 });
    this.spawn = { x: anchor.x - w / 2, y: anchor.y - h + 1 };
    this.body = createBody(this.spawn.x, this.spawn.y, w, h);
    const { w: mw, h: mh } = levelPixels(level);
    this.cam.x = Math.max(0, Math.min(mw - 256, anchor.x - 128));
    this.cam.y = Math.max(0, Math.min(mh - 224, anchor.y - 112));
  }

  get mode() {
    return this.level.playtest.mode;
  }

  private input(): Input {
    const k = this.keys;
    const jump = k.has('KeyZ') || k.has('Space') || k.has('KeyK');
    const input: Input = {
      left: k.has('ArrowLeft') || k.has('KeyA'),
      right: k.has('ArrowRight') || k.has('KeyD'),
      up: k.has('ArrowUp') || k.has('KeyW'),
      down: k.has('ArrowDown') || k.has('KeyS'),
      jump,
      jumpPressed: jump && !this.jumpWas,
      run: k.has('KeyX') || k.has('ShiftLeft') || k.has('ShiftRight') || k.has('KeyJ'),
    };
    this.jumpWas = jump;
    return input;
  }

  private respawn(why: string): void {
    this.deaths++;
    Object.assign(this.body, { x: this.spawn.x, y: this.spawn.y, vx: 0, vy: 0, climbing: false });
    this.say(why);
  }

  say(text: string): void {
    this.message = { text, until: this.tick + 120 };
  }

  /** Advance one 60 Hz frame. Returns the music track that should be playing. */
  step(): string | null {
    this.tick++;
    const input = this.input();
    const { w: mw, h: mh } = levelPixels(this.level);
    if (this.mode === 'camera') {
      const sp = input.run ? 8 : 3;
      this.cam.x = Math.max(0, Math.min(Math.max(0, mw - 256), this.cam.x + ((input.right ? 1 : 0) - (input.left ? 1 : 0)) * sp));
      this.cam.y = Math.max(0, Math.min(Math.max(0, mh - 224), this.cam.y + ((input.down ? 1 : 0) - (input.up ? 1 : 0)) * sp));
      this.checkZones(this.cam.x + 128, this.cam.y + 112);
      return this.track();
    }
    const res = this.mode === 'topdown' ? stepTopDown(this.body, input, this.world) : stepPlatformer(this.body, input, this.world);
    if (res === 'hazard') this.respawn('Ouch! Back to the spawn point.');
    else if (res === 'fell') this.respawn('Fell out of the level.');
    const cx = this.body.x + this.body.w / 2, cy = this.body.y + this.body.h / 2;
    const lock = this.checkZones(cx, cy);
    followCamera(this.cam, { x: cx, y: cy - (this.mode === 'platformer' ? 16 : 0) }, { w: mw, h: mh }, lock, undefined, this.tick < 3 ? 1 : 0.18);
    return this.track();
  }

  private checkZones(x: number, y: number): Zone | null {
    let lock: Zone | null = null;
    for (const z of this.level.zones) {
      const inside = x >= z.x && y >= z.y && x < z.x + z.width && y < z.y + z.height;
      const was = this.inside.has(z.id);
      if (inside && z.type === 'CAMERA_LOCK') lock = z;
      if (inside && !was) {
        this.inside.add(z.id);
        if (z.onEnterBgm) this.musicStack.push(z.onEnterBgm);
        if (z.type === 'HAZARD' && this.mode !== 'camera') this.respawn(`${z.name}: hazard zone.`);
        else if (z.type === 'TRIGGER') this.say(`Trigger: ${z.event || z.name}`);
        else if (z.type === 'CAMERA_LOCK') this.say(`Camera locked: ${z.name}`);
      } else if (!inside && was) {
        this.inside.delete(z.id);
        if (z.onEnterBgm) {
          const i = this.musicStack.lastIndexOf(z.onEnterBgm);
          if (i >= 0) this.musicStack.splice(i, 1);
        }
      }
    }
    return lock;
  }

  /** The music zone most recently entered wins; otherwise the level's own track. */
  track(): string | null {
    return this.musicStack.length ? this.musicStack[this.musicStack.length - 1] : this.level.meta.bgmTrackId;
  }

  /** Everything to draw as OBJ: level entities (except the spawn marker) and the player. */
  objects(project: PixelProject): SceneObject[] {
    const out: SceneObject[] = [];
    let playerSprite: string | null = null;
    for (const e of this.level.entities) {
      const r = resolveEntity(e, this.ws.templates);
      const id = refId(r.spriteRef);
      if (r.type === 'player_spawn') {
        playerSprite = id;
        continue;
      }
      if (!id || !project.sprites.some((s) => s.id === id)) continue;
      out.push({ id: e.id, spriteId: id, x: e.x, y: e.y, priority: e.priority, hFlip: e.hFlip, colorMath: false });
    }
    if (this.mode !== 'camera' && playerSprite && project.sprites.some((s) => s.id === playerSprite)) {
      out.unshift({
        id: 'player',
        spriteId: playerSprite,
        x: Math.round(this.body.x + this.body.w / 2),
        y: Math.round(this.body.y + this.body.h - 1),
        priority: 2,
        hFlip: this.body.facing < 0,
        colorMath: false,
      });
    }
    return out;
  }

  /** True when the player has no sprite and should be drawn as a box. */
  playerIsBox(project: PixelProject): boolean {
    if (this.mode === 'camera') return false;
    const e = this.level.entities.find((x) => resolveEntity(x, this.ws.templates).type === 'player_spawn');
    const id = e ? refId(resolveEntity(e, this.ws.templates).spriteRef) : null;
    return !id || !project.sprites.some((s) => s.id === id);
  }
}
