// Reads a secret from the terminal without echoing it. Bun has no hidden
// prompt built in, and `prompt()` would print the passphrase on screen and
// into any terminal recording.

// Input already read past the end of the previous answer. A pasted pair of
// lines (passphrase, then its confirmation) can arrive as a single chunk, and
// the second line must not be dropped with the first.
let pending = "";

export function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return Promise.reject(new Error("asking for a passphrase needs an interactive terminal"));
  }
  process.stderr.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();

  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
    };
    const onData = (chunk: string) => {
      const chars = [...chunk];
      for (let i = 0; i < chars.length; i++) {
        const char = chars[i]!;
        if (char === "\r" || char === "\n" || char === "\u0004") {
          // A CRLF pair is one line ending, not an empty next answer.
          const next = char === "\r" && chars[i + 1] === "\n" ? i + 2 : i + 1;
          pending = chars.slice(next).join("");
          finish();
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          finish();
          reject(new Error("cancelled"));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = [...value].slice(0, -1).join("");
          continue;
        }
        value += char;
      }
    };
    stdin.on("data", onData);
    if (pending) {
      const buffered = pending;
      pending = "";
      onData(buffered);
    }
  });
}
