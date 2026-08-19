interface HandoffWindow {
  once: (event: 'ready-to-show', listener: () => void) => unknown;
  isDestroyed: () => boolean;
  close: () => void;
}

/** Close the outgoing shell only after its already-wired replacement is ready. */
export function handoffWhenReady(
  replacement: HandoffWindow,
  outgoing: HandoffWindow | null,
  after?: () => void,
): Promise<void> {
  return new Promise((resolve) => {
    replacement.once('ready-to-show', () => {
      if (outgoing && !outgoing.isDestroyed()) outgoing.close();
      after?.();
      resolve();
    });
  });
}
