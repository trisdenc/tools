import { useSyncExternalStore } from 'react';
import { Editor } from '../core/editor';

export const useEditorVersion = (ed: Editor): number => useSyncExternalStore(ed.subscribe, ed.getVersion);
/** Re-render on hover, pan and playback ticks as well as structural changes. */
export const useFastVersion = (ed: Editor): number => useSyncExternalStore(ed.subscribeFast, ed.getFastVersion);

/** True when keyboard focus is in a text field, so global shortcuts should stand aside. */
export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return true;
  if (tag === 'INPUT') {
    const type = (t as HTMLInputElement).type;
    return !['checkbox', 'radio', 'range', 'button'].includes(type);
  }
  return false;
}
