/**
 * Background-playback graph, shared by the practice and drill players.
 *
 * Audio is routed through Web Audio into a MediaStream that a second, never-paused "output"
 * <audio> element plays. To the OS one track is playing continuously, including during the
 * silent gaps, so the page is not suspended when the screen is off (iOS freezes JS within seconds
 * of audio stopping; Android throttles/freezes background tabs). Timers are scheduled on the audio
 * clock (ConstantSourceNode.onended) rather than setTimeout, which background tabs throttle.
 */
export interface Graph {
  ctx: AudioContext;
  dest: MediaStreamAudioDestinationNode;
  out: HTMLAudioElement;
  /** Set when the output element couldn't play; audio goes straight to ctx.destination. */
  direct: boolean;
  /** Whether the output element has had its first, settling start (see startOutput). */
  settled: boolean;
}

export function createGraph(): Graph | null {
  const AC: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  try {
    const ctx = new AC();
    const dest = ctx.createMediaStreamDestination();
    const out = new Audio();
    out.srcObject = dest.stream;
    // iOS 17+: keep playing under the lock screen and with the mute switch on.
    const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
    if (session) {
      try {
        session.type = "playback";
      } catch {
        /* unsupported */
      }
    }
    return { ctx, dest, out, direct: false, settled: false };
  } catch {
    return null;
  }
}

/** How long the output element runs before its restart (see startOutput). */
const OUTPUT_SETTLE_SEC = 0.4;

/**
 * Starts the keep-alive output element, if it isn't playing. Started cold on a phone, it can build
 * up a backlog while the audio output opens and then work it off by playing fast: heard as the
 * second play of the first phrase speeding up, until pausing and playing again cured it. So the
 * first start runs it briefly and restarts it with the output already open before returning; later
 * starts (after a pause) play at once. Throws if the element won't play, so callers can send audio
 * straight to the speakers instead.
 */
export async function startOutput(g: Graph): Promise<void> {
  if (!g.out.paused) return;
  await g.out.play();
  if (g.settled) return;
  g.settled = true;
  await new Promise<void>((resolve) => schedule(g, OUTPUT_SETTLE_SEC, resolve));
  if (g.out.paused) return; // stopped meanwhile
  g.out.pause();
  await g.out.play();
}

/** Where sources should connect: the keep-alive stream, or the speakers once that has failed. */
export function outputOf(g: Graph): AudioNode {
  return g.direct ? g.ctx.destination : g.dest;
}

/** Runs cb after `seconds`, using the audio clock when available. Returns a cancel function. */
export function schedule(g: Graph | null, seconds: number, cb: () => void): () => void {
  if (g && g.ctx.state === "running") {
    try {
      const n = g.ctx.createConstantSource();
      n.offset.value = 0; // silent
      n.connect(g.dest);
      n.onended = () => {
        n.disconnect();
        cb();
      };
      n.start();
      n.stop(g.ctx.currentTime + Math.max(0, seconds));
      return () => {
        n.onended = null;
        try {
          n.stop();
        } catch {
          /* already stopped */
        }
        n.disconnect();
      };
    } catch {
      /* fall through to setTimeout */
    }
  }
  const id = window.setTimeout(cb, Math.max(0, seconds * 1000));
  return () => window.clearTimeout(id);
}
