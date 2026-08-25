const fs = require("node:fs");
const path = require("node:path");
const util = require("node:util");

function createLogger({ app, filename = "main.log" }) {
  const logPath = path.join(app.getPath("logs"), filename);

  function write(level, args) {
    const line = `${new Date().toISOString()} ${level} ${formatArgs(args)}\n`;
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, line, "utf8");
    } catch {
      // Logging must never break the app.
    }
  }

  return {
    path: logPath,
    info: (...args) => write("INFO", args),
    error: (...args) => write("ERROR", args)
  };
}

function formatArgs(args) {
  return args.map((arg) => {
    if (arg instanceof Error) return arg.stack || arg.message;
    if (typeof arg === "string") return arg;
    return util.inspect(arg, { depth: 4, breakLength: 160, compact: true });
  }).join(" ");
}

module.exports = { createLogger };
