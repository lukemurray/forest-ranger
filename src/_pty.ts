import * as pty from "node-pty";
const p = pty.spawn("/bin/zsh", ["-l","-c","echo HELLO_FROM_PTY; tty; tput colors 2>/dev/null"], {
  name: "xterm-color", cols: 80, rows: 24, cwd: process.env.HOME, env: process.env as Record<string,string>,
});
let out = "";
p.onData((d) => out += d);
p.onExit(({exitCode}) => { console.log("OUTPUT:", JSON.stringify(out.trim())); console.log("exit:", exitCode); });
