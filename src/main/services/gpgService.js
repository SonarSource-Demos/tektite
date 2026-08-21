const { spawn } = require("node:child_process");

const PGP_MESSAGE_HEADER = "-----BEGIN PGP MESSAGE-----";

function isEncrypted(content) {
  return typeof content === "string" && content.trimStart().startsWith(PGP_MESSAGE_HEADER);
}

async function encrypt(content, recipient) {
  return (await encryptBuffer(Buffer.from(content || "", "utf8"), recipient)).toString("utf8");
}

async function encryptBuffer(content, recipient) {
  if (!recipient || typeof recipient !== "string") throw new Error("GPG recipient key is required.");
  return runGpg([
    "--batch",
    "--yes",
    "--armor",
    "--trust-model",
    "always",
    "--encrypt",
    "--recipient",
    recipient
  ], content);
}

async function decrypt(content, passphrase = "") {
  return (await decryptBuffer(Buffer.from(content || "", "utf8"), passphrase)).toString("utf8");
}

async function decryptBuffer(content, passphrase = "") {
  const args = ["--batch", "--yes"];
  const stdio = ["pipe", "pipe", "pipe"];

  if (passphrase) {
    args.push("--pinentry-mode", "loopback", "--passphrase-fd", "3");
    stdio.push("pipe");
  }

  args.push("--decrypt");
  return runGpg(args, content, { passphrase, stdio });
}

function runGpg(args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("gpg", args, { stdio: options.stdio || ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const errorText = Buffer.concat(stderr).toString("utf8").trim();
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(errorText || `gpg exited with ${code}`));
    });

    if (options.passphrase && child.stdio[3]) {
      child.stdio[3].end(`${options.passphrase}\n`);
    }
    child.stdin.end(input || Buffer.alloc(0));
  });
}

module.exports = { decrypt, decryptBuffer, encrypt, encryptBuffer, isEncrypted };
