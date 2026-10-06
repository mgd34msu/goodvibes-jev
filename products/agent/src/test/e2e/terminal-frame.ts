/** Text projection of the PTY's current VT screen, including cursor-addressed
 * diffs. Never use accumulated output as evidence that a prompt is still visible. */
export class TerminalFrame {
  private lines: string[][];
  private row = 0;
  private col = 0;
  private pending = '';
  private saved = [0, 0];
  constructor(private cols: number, private rows: number) { this.lines = this.blank(); }
  private blank() { return Array.from({ length: this.rows }, () => Array<string>(this.cols).fill(' ')); }
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; this.lines = this.blank(); this.row = 0; this.col = 0; }
  text() { return this.lines.map(line => line.join('').trimEnd()).join('\n'); }
  write(chunk: string, reply: (bytes: string) => void) {
    let text = this.pending + chunk; this.pending = '';
    while (text) {
      if (text.startsWith('\x1b[')) {
        const sequence = /^\x1b\[([0-?]*)([ -/]*)([@-~])/.exec(text);
        if (!sequence) { this.pending = text; break; }
        const parameters = sequence[1]!;
        const n = parameters.replace(/^[?<=>]/, '').split(';').map(value => Number(value) || 0);
        const amount = n[0] || 1;
        switch (sequence[3]) {
          case 'H': case 'f': this.row = (n[0] || 1) - 1; this.col = (n[1] || 1) - 1; break;
          case 'A': this.row -= amount; break;
          case 'B': this.row += amount; break;
          case 'C': this.col += amount; break;
          case 'D': this.col -= amount; break;
          case 'E': this.row += amount; this.col = 0; break;
          case 'F': this.row -= amount; this.col = 0; break;
          case 'G': this.col = amount - 1; break;
          case 'd': this.row = amount - 1; break;
          case 'J':
            if (n[0] === 2 || n[0] === 3) this.lines = this.blank();
            else if (n[0] === 0) { this.lines[this.row]!.fill(' ', this.col); for (let row = this.row + 1; row < this.rows; row++) this.lines[row]!.fill(' '); }
            else { for (let row = 0; row < this.row; row++) this.lines[row]!.fill(' '); this.lines[this.row]!.fill(' ', 0, this.col + 1); }
            break;
          case 'K': this.lines[this.row]!.fill(' ', n[0] === 1 || n[0] === 2 ? 0 : this.col, n[0] === 1 ? this.col + 1 : this.cols); break;
          case 'X': this.lines[this.row]!.fill(' ', this.col, Math.min(this.cols, this.col + amount)); break;
          case 's': this.saved = [this.row, this.col]; break;
          case 'u': [this.row, this.col] = this.saved as [number, number]; break;
          case 'h': if (parameters === '?1049') { this.lines = this.blank(); this.row = 0; this.col = 0; } break;
          // SGR, mode switches, cursor shape and synchronization affect style,
          // not the text/cursor coordinates this fixture inspects.
        }
        this.row = Math.max(0, Math.min(this.rows - 1, this.row));
        this.col = Math.max(0, Math.min(this.cols - 1, this.col));
        text = text.slice(sequence[0].length); continue;
      }
      if (text.startsWith('\x1b]')) {
        const end = /\x07|\x1b\\/.exec(text);
        if (!end) { this.pending = text; break; }
        const query = /^\x1b\](10|11|4;\d+);\?$/.exec(text.slice(0, end.index));
        if (query) reply(`\x1b]${query[1]};rgb:${query[1] === '11' ? '0000/0000/0000' : 'ffff/ffff/ffff'}\x07`);
        text = text.slice(end.index + end[0].length); continue;
      }
      if (text[0] === '\x1b') {
        if (text.length < 2) { this.pending = text; break; }
        if (text[1] === '7') this.saved = [this.row, this.col];
        if (text[1] === '8') [this.row, this.col] = this.saved as [number, number];
        text = text.slice(2); continue;
      }
      const point = text.codePointAt(0)!;
      const char = String.fromCodePoint(point); text = text.slice(char.length);
      if (char === '\r') { this.col = 0; continue; }
      if (char === '\n') { if (++this.row === this.rows) { this.lines.shift(); this.lines.push(Array<string>(this.cols).fill(' ')); this.row--; } continue; }
      if (char === '\b') { this.col = Math.max(0, this.col - 1); continue; }
      if (char === '\t') { this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8); continue; }
      if (point < 32 || point === 127) continue;
      const width = Bun.stringWidth(char);
      if (width === 0) continue;
      if (this.col >= this.cols) { this.col = 0; if (++this.row >= this.rows) { this.lines.shift(); this.lines.push(Array<string>(this.cols).fill(' ')); this.row = this.rows - 1; } }
      this.lines[this.row]![this.col] = char;
      if (width === 2 && this.col + 1 < this.cols) this.lines[this.row]![this.col + 1] = '';
      this.col += width;
    }
  }
}

