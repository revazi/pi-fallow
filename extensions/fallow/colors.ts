export const ansi = (code: number, text: string) => `\x1b[38;5;${code}m${text}\x1b[39m`;
export const fallowPurple = (text: string) => ansi(141, text);
