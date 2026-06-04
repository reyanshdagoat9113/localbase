import pc from "picocolors";

export const log = {
  success: (msg: string) => console.log(pc.green("✔") + " " + msg),
  error: (msg: string) => console.error(pc.red("✖") + " " + msg),
  info: (msg: string) => console.log(pc.cyan("ℹ") + " " + msg),
  warn: (msg: string) => console.log(pc.yellow("▲") + " " + msg),
  heading: (msg: string) => console.log(pc.bold(pc.cyan(msg))),
  hint: (msg: string) => console.log(pc.dim("  ↳ " + msg)),
};
