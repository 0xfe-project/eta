/**
 * Reads the colours and styles of a frame line: for each character, the foreground, the
 * background, bold and reverse video that Ink's SGR sequences left in force before it.
 */

interface State {
  fg: string | undefined;
  bg: string | undefined;
  bold: boolean;
  inverse: boolean;
}

/** Applies one SGR sequence's parameters to the state. */
function apply(state: State, params: string): void {
  const codes = params === "" ? ["0"] : params.split(";");
  for (let i = 0; i < codes.length; i += 1) {
    const code = Number(codes[i]);
    if (code === 38 || code === 48) {
      const width = codes[i + 1] === "5" ? 2 : 4;
      const value = codes.slice(i, i + 1 + width).join(";");
      if (code === 38) state.fg = value;
      else state.bg = value;
      i += width;
    } else if (code === 0) {
      state.fg = undefined;
      state.bg = undefined;
      state.bold = false;
      state.inverse = false;
    } else if (code === 1) state.bold = true;
    else if (code === 22) state.bold = false;
    else if (code === 7) state.inverse = true;
    else if (code === 27) state.inverse = false;
    else if (code === 39) state.fg = undefined;
    else if (code === 49) state.bg = undefined;
    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97))
      state.fg = String(code);
    else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107))
      state.bg = String(code);
  }
}

/**
 * True when any SGR sequence in the text sets a background colour (`4X`, `10X`, `48;…`) or
 * reverse video (`7`), whether or not a character follows it.
 */
export function hasBackground(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  for (const match of text.matchAll(/\u001B\[([0-9;]*)m/g)) {
    const state: State = {
      fg: undefined,
      bg: undefined,
      bold: false,
      inverse: false,
    };
    apply(state, match[1] ?? "");
    if (state.bg !== undefined || state.inverse) return true;
  }
  return false;
}
