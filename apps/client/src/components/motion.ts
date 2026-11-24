// The app's motion, said once (#378, #379, #380 share this file): every duration something
// moves or waits by is here, beside what it is for. Durations are milliseconds.

export const motion = {
  /** A wait shorter than this shows nothing: a spinner or a skeleton appears only once a wait
   * has lasted this long (#380). */
  reveal: 150,
  /** A spinner or a skeleton that appeared stays at least this long, so it never flashes. */
  minShown: 300,
  /** One turn of a spinner, or of a button's own icon while its action runs. */
  spin: 800,
} as const;
