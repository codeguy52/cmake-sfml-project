/**
 * Adding the app to a phone's home screen.
 *
 * Android and desktop Chrome fire `beforeinstallprompt`, which can be saved
 * and replayed later as a real one-tap install. iOS fires nothing and has no
 * API at all, so there the only honest thing is to describe the two taps.
 *
 * The event fires early — often before React has mounted — so the listener is
 * registered at module load and the event is held for whoever asks later.
 */

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    // Chrome shows its own mini-infobar unless the event is preempted; the app
    // asks at the end of setup instead, where it is in context.
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    notify();
  });

  window.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether a real install prompt is available right now. */
export function canPromptInstall(): boolean {
  return deferred !== null;
}

/** Show the browser's install prompt. Resolves true if the app was installed. */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const event = deferred;
  // Each saved event may only be used once.
  deferred = null;
  notify();
  await event.prompt();
  const { outcome } = await event.userChoice;
  return outcome === 'accepted';
}

/** True when already running as an installed app rather than in a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const iosStandalone = (window.navigator as { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia('(display-mode: standalone)').matches;
}

export type Platform = 'ios' | 'android' | 'desktop';

export function platform(): Platform {
  if (typeof navigator === 'undefined') return 'desktop';
  const ua = navigator.userAgent;
  // iPadOS 13+ reports itself as a Mac, so touch points are the tell.
  const iPadOS = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  if (/iPhone|iPad|iPod/.test(ua) || iPadOS) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

/** The two taps, per platform, for when there is no prompt to show. */
export function installSteps(target: Platform = platform()): string {
  switch (target) {
    case 'ios':
      return 'Tap the Share button, then "Add to Home Screen".';
    case 'android':
      return 'Tap the ⋮ menu, then "Add to Home screen" or "Install app".';
    default:
      return 'Use your browser\'s install button in the address bar.';
  }
}
