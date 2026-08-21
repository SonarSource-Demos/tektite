const fs = require("node:fs/promises");
const path = require("node:path");

const gpgService = require("./gpgService");

const DEFAULT_TEMPLATES_PATH = ".tektite/templates";
const DEFAULT_SETTINGS = {
  templatesPath: "",
  autoLinkUrls: false,
  tocListStyle: "unordered",
  tocIncludeSubfolders: false,
  treeFontSize: null,
  editorFontSize: null,
  encryptionEnabled: false,
  encryptionRecipient: ""
};
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"]);
const encryptionExcludedDirs = new Set([".tektite", ".git", "node_modules"]);
const encryptionExcludedFiles = new Set([".DS_Store", ".gitignore"]);

async function validateVaultRoot(rootPath) {
  const normalizedRoot = path.resolve(rootPath);
  let stat;
  try {
    stat = await fs.stat(normalizedRoot); // NOSONAR S2083 -- rootPath is the vault root, resolved above
  } catch (error) {
    if (error?.code === "ENOENT") return vaultNotFound(normalizedRoot);
    throw error;
  }

  if (!stat.isDirectory()) return vaultNotFound(normalizedRoot);
  return { ok: true };
}

function vaultNotFound(rootPath) {
  return {
    ok: false,
    code: "VAULT_NOT_FOUND",
    message: "The vault folder doesn't exist anymore.",
    path: rootPath
  };
}

async function scanVault(rootPath, encryption = {}) {
  assertInsideVault(rootPath, rootPath);
  const tree = await readDirectory(rootPath, rootPath, encryption);
  const notes = flattenNotes(tree);
  return { tree, notes };
}

async function readNote(rootPath, relativePath, encryption = {}) {
  return readNoteContent(rootPath, relativePath, encryption);
}

async function noteModifiedTimes(rootPath, relativePaths = []) {
  const paths = Array.isArray(relativePaths) ? relativePaths : [];
  return Promise.all(paths.map(async (relativePath) => {
    const filePath = resolveVaultFilePath(rootPath, relativePath, await loadSettings(rootPath));
    let stat;
    try {
      stat = await fs.stat(filePath); // NOSONAR S2083 -- filePath from resolveVaultPath
    } catch (error) {
      if (error?.code === "ENOENT") return { path: relativePath, modifiedAt: null };
      throw error;
    }
    return { path: relativePath, modifiedAt: stat.mtimeMs };
  }));
}

async function writeNote(rootPath, relativePath, content, encryption = {}) {
  const filePath = resolveVaultFilePath(rootPath, relativePath, encryption); // NOSONAR S2083 -- resolveVaultPath validates startsWith
  await fs.mkdir(path.dirname(filePath), { recursive: true }); // NOSONAR S2083
  await fs.writeFile(filePath, await noteContentForDisk(content, encryption), "utf8"); // NOSONAR S2083
  const stat = await fs.stat(filePath); // NOSONAR S2083
  return {
    path: relativePath,
    title: noteTitle(relativePath),
    modifiedAt: stat.mtimeMs
  };
}

async function createNote(rootPath, requestedName, folder = "", templatePath = "", encryption = {}) {
  const safeName = sanitizeNoteName(requestedName || "Untitled");
  const baseFolder = normalizeRelative(folder);
  let candidate = path.posix.join(baseFolder, `${safeName}.md`);
  let index = 2;

  while (await existsAnyFilePath(rootPath, candidate)) {
    candidate = path.posix.join(baseFolder, `${safeName} ${index}.md`);
    index += 1;
  }

  const filePath = resolveVaultFilePath(rootPath, candidate, encryption); // NOSONAR S2083 -- resolveVaultPath validates startsWith
  await fs.mkdir(path.dirname(filePath), { recursive: true }); // NOSONAR S2083

  let content = `# ${path.basename(candidate, ".md")}\n\n`;
  if (templatePath) content = await readTemplateContent(rootPath, templatePath, encryption);

  await fs.writeFile(filePath, await noteContentForDisk(content, encryption), "utf8"); // NOSONAR S2083
  return candidate;
}

async function listTemplates(rootPath, templatesPath = "", encryption = {}) {
  const relPath = trimSlashes((templatesPath || DEFAULT_TEMPLATES_PATH).replaceAll("\\", "/"));
  const templatesDir = resolveVaultPath(rootPath, relPath);
  try {
    const entries = await fs.readdir(templatesDir, { withFileTypes: true }); // NOSONAR S2083 -- templatesDir from resolveVaultPath
    return entries
      .filter((entry) => entry.isFile() && logicalFileName(entry.name, encryption).toLowerCase().endsWith(".md"))
      .map((entry) => {
        const name = logicalFileName(entry.name, encryption);
        return { name: path.basename(name, ".md"), path: `${relPath}/${name}` };
      });
  } catch {
    return [];
  }
}

async function loadSettings(rootPath) {
  try {
    const settingsFile = resolveVaultPath(rootPath, path.join(".tektite", "settings.json")); // NOSONAR S2083 -- resolveVaultPath validates startsWith
    const raw = await fs.readFile(settingsFile, "utf8"); // NOSONAR S2083
    const parsed = JSON.parse(raw);
    return normalizeSettings(parsed);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function normalizeSettings(parsed = {}) {
  return {
      templatesPath: typeof parsed.templatesPath === "string" ? parsed.templatesPath : "",
      autoLinkUrls: Boolean(parsed.autoLinkUrls),
      tocListStyle: parsed.tocListStyle === "ordered" ? "ordered" : "unordered",
      tocIncludeSubfolders: Boolean(parsed.tocIncludeSubfolders),
      treeFontSize: typeof parsed.treeFontSize === "number" ? parsed.treeFontSize : null,
      editorFontSize: typeof parsed.editorFontSize === "number" ? parsed.editorFontSize : null,
      encryptionEnabled: Boolean(parsed.encryptionEnabled),
      encryptionRecipient: typeof parsed.encryptionRecipient === "string" ? parsed.encryptionRecipient.trim() : ""
  };
}

async function saveSettings(rootPath, settings, encryption = {}) {
  const previousSettings = await loadSettings(rootPath);
  const nextSettings = normalizeSettings(settings);
  await migrateNoteEncryption(rootPath, previousSettings, nextSettings, encryption);
  const settingsFile = resolveVaultPath(rootPath, path.join(".tektite", "settings.json")); // NOSONAR S2083 -- resolveVaultPath validates startsWith
  await fs.mkdir(path.dirname(settingsFile), { recursive: true }); // NOSONAR S2083
  await fs.writeFile(settingsFile, JSON.stringify(nextSettings, null, 2), "utf8"); // NOSONAR S2083
  return true;
}

async function createFolder(rootPath, requestedName, parentFolder = "") {
  const safeName = sanitizeEntryName(requestedName || "Untitled folder", "Untitled folder");
  const baseFolder = normalizeRelative(parentFolder);
  let candidate = path.posix.join(baseFolder, safeName);
  let index = 2;

  while (await existsAnyFilePath(rootPath, candidate)) {
    candidate = path.posix.join(baseFolder, `${safeName} ${index}`);
    index += 1;
  }

  await fs.mkdir(resolveVaultPath(rootPath, candidate), { recursive: false }); // NOSONAR S2083 -- resolveVaultPath validates startsWith
  return candidate;
}

async function deleteEntry(rootPath, relativePath, type, encryption = {}) {
  const normalized = normalizeRelative(relativePath);
  if (!normalized) throw new Error("Cannot delete the vault root.");

  const entryPath = type === "folder"
    ? resolveVaultPath(rootPath, normalized)
    : resolveVaultFilePath(rootPath, normalized, encryption); // NOSONAR S2083 -- resolveVaultPath validates startsWith
  const stat = await fs.stat(entryPath); // NOSONAR S2083
  assertEntryType(stat, type);

  if (stat.isDirectory()) await fs.rm(entryPath, { recursive: true, force: false }); // NOSONAR S2083
  else await fs.unlink(entryPath); // NOSONAR S2083
  return true;
}

async function renameEntry(rootPath, relativePath, type, requestedName, encryption = {}) {
  const normalized = normalizeRelative(relativePath);
  if (!normalized) throw new Error("Cannot rename the vault root.");

  const fromPath = type === "folder"
    ? resolveVaultPath(rootPath, normalized)
    : resolveVaultFilePath(rootPath, normalized, encryption); // NOSONAR S2083 -- resolveVaultPath validates startsWith
  const stat = await fs.stat(fromPath); // NOSONAR S2083
  assertEntryType(stat, type);

  const currentName = path.basename(normalized);
  const nextName = renamedEntryName(currentName, requestedName, type);
  if (!nextName || nextName === currentName) return normalized;

  const candidate = path.posix.join(parentPosix(normalized), nextName);
  const toPath = type === "folder"
    ? resolveVaultPath(rootPath, candidate)
    : resolveVaultFilePath(rootPath, candidate, encryption); // NOSONAR S2083 -- resolveVaultPath validates startsWith
  if (type === "folder" ? await exists(toPath) : await existsAnyFilePath(rootPath, candidate)) throw new Error(`"${nextName}" already exists.`);

  await fs.rename(fromPath, toPath); // NOSONAR S2083
  await updateMovedReferences(rootPath, type, normalized, candidate, encryption);
  return candidate;
}

async function moveEntry(rootPath, relativePath, type, targetFolder = "", encryption = {}) {
  const normalized = normalizeRelative(relativePath);
  if (!normalized) throw new Error("Cannot move the vault root.");

  const fromPath = type === "folder"
    ? resolveVaultPath(rootPath, normalized)
    : resolveVaultFilePath(rootPath, normalized, encryption); // NOSONAR S2083 -- resolveVaultPath validates startsWith
  const stat = await fs.stat(fromPath); // NOSONAR S2083
  assertEntryType(stat, type);

  const destinationFolder = normalizeRelative(targetFolder);
  if (type === "folder" && destinationFolder && (destinationFolder === normalized || destinationFolder.startsWith(`${normalized}/`))) {
    throw new Error("Cannot move a folder inside itself.");
  }

  const baseName = path.basename(normalized);
  let candidate = path.posix.join(destinationFolder, baseName);
  let index = 2;
  const parsed = path.parse(baseName);

  while (stat.isDirectory() ? await exists(resolveVaultPath(rootPath, candidate)) : await existsAnyFilePath(rootPath, candidate)) {
    const nextName = stat.isDirectory() ? `${baseName} ${index}` : `${parsed.name} ${index}${parsed.ext}`;
    candidate = path.posix.join(destinationFolder, nextName);
    index += 1;
  }

  const toPath = stat.isDirectory()
    ? resolveVaultPath(rootPath, candidate)
    : resolveVaultFilePath(rootPath, candidate, encryption); // NOSONAR S2083 -- resolveVaultPath validates startsWith
  await fs.mkdir(path.dirname(toPath), { recursive: true }); // NOSONAR S2083
  await fs.rename(fromPath, toPath); // NOSONAR S2083
  await updateMovedReferences(rootPath, type, normalized, candidate, encryption);
  return candidate;
}

async function importImage(rootPath, sourcePath, targetFolder = "", encryption = {}) {
  const sourceStat = await fs.stat(sourcePath);
  if (!sourceStat.isFile()) throw new Error("Dropped item is not a file.");

  const extension = path.extname(sourcePath).toLowerCase();
  if (!imageExtensions.has(extension)) throw new Error("Dropped file is not a supported image.");

  const baseFolder = normalizeRelative(targetFolder);
  const sourceName = sanitizeEntryName(path.basename(sourcePath, extension), "image");
  let candidate = path.posix.join(baseFolder, `${sourceName}${extension}`);
  let index = 2;

  while (await existsAnyFilePath(rootPath, candidate)) {
    candidate = path.posix.join(baseFolder, `${sourceName} ${index}${extension}`);
    index += 1;
  }

  const destinationPath = resolveVaultFilePath(rootPath, candidate, encryption); // NOSONAR S2083 -- resolveVaultPath validates startsWith
  await fs.mkdir(path.dirname(destinationPath), { recursive: true }); // NOSONAR S2083
  const data = await fs.readFile(sourcePath); // NOSONAR S2083
  await fs.writeFile(destinationPath, await fileContentForDisk(data, encryption)); // NOSONAR S2083
  return assetPayload(candidate);
}

async function importFileOrDirectory(rootPath, sourcePath, targetFolder = "", encryption = {}) {
  const sourceStat = await fs.stat(sourcePath);
  const isDirectory = sourceStat.isDirectory();
  const isFile = sourceStat.isFile();
  if (!isFile && !isDirectory) throw new Error("Dropped item is neither a file nor a directory.");

  const baseFolder = normalizeRelative(targetFolder);
  let candidate = "";
  if (isFile) {
    const extension = path.extname(sourcePath).toLowerCase();
    const baseName = sanitizeEntryName(path.basename(sourcePath, extension), "file");
    candidate = path.posix.join(baseFolder, `${baseName}${extension}`);
    let index = 2;
    while (await existsAnyFilePath(rootPath, candidate)) {
      candidate = path.posix.join(baseFolder, `${baseName} ${index}${extension}`);
      index += 1;
    }
  } else {
    const sourceName = sanitizeEntryName(path.basename(sourcePath), "folder");
    candidate = path.posix.join(baseFolder, sourceName);
    let index = 2;
    while (await exists(resolveVaultPath(rootPath, candidate))) {
      candidate = path.posix.join(baseFolder, `${sourceName} ${index}`);
      index += 1;
    }
  }

  const destinationPath = isFile
    ? resolveVaultFilePath(rootPath, candidate, encryption)
    : resolveVaultPath(rootPath, candidate); // NOSONAR S2083 -- resolveVaultPath validates startsWith
  await fs.mkdir(path.dirname(destinationPath), { recursive: true }); // NOSONAR S2083
  if (encryption.enabled) {
    if (isFile && isEncryptionExcludedFilePath(candidate)) await fs.copyFile(sourcePath, destinationPath); // NOSONAR S2083
    else if (isFile) await fs.writeFile(destinationPath, await fileContentForDisk(await fs.readFile(sourcePath), encryption)); // NOSONAR S2083
    else await copyEncryptedDirectory(sourcePath, destinationPath, encryption);
  } else {
    await fs.cp(sourcePath, destinationPath, { recursive: true }); // NOSONAR S2083
  }
  return {
    path: candidate,
    name: path.basename(candidate),
    label: isFile ? path.basename(candidate, path.extname(candidate)) : path.basename(candidate)
  };
}

async function saveClipboardImage(rootPath, targetFolder = "", image = {}, encryption = {}) {
  const dataUrl = typeof image.dataUrl === "string" ? image.dataUrl : "";
  const match = dataUrl.match(/^data:(image\/[a-z0-9+.-]+);base64,([a-z0-9+/=]+)$/i);
  if (!match) throw new Error("Clipboard image data is invalid.");

  const mimeType = match[1].toLowerCase();
  const extension = clipboardImageExtension(mimeType, image.name);
  if (!imageExtensions.has(extension)) throw new Error("Clipboard image type is not supported.");

  const baseFolder = normalizeRelative(targetFolder);
  const candidate = await clipboardImageCandidate(rootPath, baseFolder, image.name, extension);
  const destinationPath = resolveVaultFilePath(rootPath, candidate, encryption); // NOSONAR S2083 -- resolveVaultPath validates startsWith
  await fs.mkdir(path.dirname(destinationPath), { recursive: true }); // NOSONAR S2083
  await fs.writeFile(destinationPath, await fileContentForDisk(Buffer.from(match[2], "base64"), encryption)); // NOSONAR S2083
  return assetPayload(candidate);
}

async function readAssetDataUrl(rootPath, relativePath, encryption = {}) {
  const filePath = resolveVaultFilePath(rootPath, relativePath, encryption); // NOSONAR S2083 -- resolveVaultPath validates startsWith
  const extension = path.extname(relativePath).toLowerCase();
  if (!imageExtensions.has(extension)) throw new Error("Selected file is not a supported image.");
  const diskData = await fs.readFile(filePath); // NOSONAR S2083
  const data = encryption.enabled ? await gpgService.decryptBuffer(diskData, encryption.passphrase || "") : diskData;
  return `data:${imageMimeType(extension)};base64,${data.toString("base64")}`;
}

async function readDirectory(rootPath, currentPath, encryption = {}) {
  assertInsideVault(rootPath, currentPath);
  const entries = await fs.readdir(currentPath, { withFileTypes: true }); // NOSONAR S2083 -- assertInsideVault validates startsWith
  const children = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".") || encryptionExcludedDirs.has(entry.name) || entry.name === "node_modules") continue;

    const absolute = path.join(currentPath, entry.name);
    const relative = toPosix(path.relative(rootPath, absolute));

    if (entry.isDirectory()) {
      children.push(await readDirectory(rootPath, absolute, encryption));
    } else if (entry.isFile() && logicalFileName(entry.name, encryption).toLowerCase().endsWith(".md")) {
      const stat = await fs.stat(absolute);
      const logicalRelative = logicalRelativePath(relative, encryption);
      children.push({ type: "note", name: logicalFileName(entry.name, encryption), title: noteTitle(logicalRelative), path: logicalRelative, modifiedAt: stat.mtimeMs });
    } else if (entry.isFile() && imageExtensions.has(path.extname(logicalFileName(entry.name, encryption)).toLowerCase())) {
      const stat = await fs.stat(absolute);
      const logicalName = logicalFileName(entry.name, encryption);
      const logicalRelative = logicalRelativePath(relative, encryption);
      children.push({
        type: "asset",
        kind: "image",
        name: logicalName,
        title: path.basename(logicalName, path.extname(logicalName)),
        path: logicalRelative,
        modifiedAt: stat.mtimeMs
      });
    }
  }

  children.sort((a, b) => {
    const order = { folder: 0, note: 1, asset: 2 };
    if (a.type !== b.type) return order[a.type] - order[b.type];
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  return {
    type: "folder",
    name: path.basename(currentPath),
    path: toPosix(path.relative(rootPath, currentPath)),
    children
  };
}

function flattenNotes(node) {
  if (node.type === "note") return [node];
  if (!Array.isArray(node.children)) return [];

  const notes = [];
  for (const child of node.children) notes.push(...flattenNotes(child));
  return notes;
}

async function readNoteContent(rootPath, relativePath, encryption = {}) {
  const raw = await fs.readFile(resolveVaultFilePath(rootPath, relativePath, encryption), "utf8"); // NOSONAR S2083 -- resolveVaultPath validates startsWith
  if (gpgService.isEncrypted(raw)) return gpgService.decrypt(raw, encryption.passphrase || "");
  return raw;
}

async function readTemplateContent(rootPath, templatePath, encryption = {}) {
  try {
    return await readNoteContent(rootPath, templatePath, encryption);
  } catch {
    return fs.readFile(resolveVaultPath(rootPath, templatePath), "utf8"); // NOSONAR S2083 -- resolveVaultPath validates startsWith
  }
}

async function noteContentForDisk(content, encryption = {}) {
  if (!encryption.enabled) return content;
  if (gpgService.isEncrypted(content)) return content;
  return gpgService.encrypt(content, encryption.recipient);
}

async function fileContentForDisk(content, encryption = {}) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content || "", "utf8");
  return encryption.enabled ? gpgService.encryptBuffer(buffer, encryption.recipient) : buffer;
}

async function migrateNoteEncryption(rootPath, previousSettings, nextSettings, encryption = {}) {
  const wasEnabled = Boolean(previousSettings.encryptionEnabled);
  const isEnabled = Boolean(nextSettings.encryptionEnabled);
  const recipientChanged = wasEnabled && isEnabled && previousSettings.encryptionRecipient !== nextSettings.encryptionRecipient;
  if (wasEnabled === isEnabled && !recipientChanged) return;
  if (isEnabled && !nextSettings.encryptionRecipient) throw new Error("GPG recipient key is required to encrypt vault files.");

  const files = await vaultFiles(rootPath, rootPath);
  const nextEncryption = encryptionConfig(nextSettings, encryption);

  for (const relativePath of files) {
    const filePath = resolveVaultPath(rootPath, relativePath);
    const sourceEncrypted = wasEnabled && relativePath.endsWith(".gpg");
    const targetRelativePath = isEnabled
      ? (wasEnabled ? relativePath : `${relativePath}.gpg`)
      : (sourceEncrypted ? decryptedRelativePath(relativePath) : relativePath);
    if (targetRelativePath !== relativePath && await exists(resolveVaultPath(rootPath, targetRelativePath))) {
      throw new Error(`Cannot migrate encryption: "${targetRelativePath}" already exists.`);
    }
    const raw = await fs.readFile(filePath); // NOSONAR S2083
    const plain = sourceEncrypted ? await gpgService.decryptBuffer(raw, encryption.passphrase || "") : raw;
    const nextContent = isEnabled ? await fileContentForDisk(plain, nextEncryption) : plain;
    const targetPath = resolveVaultPath(rootPath, targetRelativePath);
    await fs.writeFile(targetPath, nextContent); // NOSONAR S2083
    if (targetPath !== filePath) await fs.unlink(filePath); // NOSONAR S2083
  }
}

function encryptionConfig(settings = {}, encryption = {}) {
  return {
    enabled: Boolean(settings.encryptionEnabled),
    recipient: settings.encryptionRecipient || encryption.recipient || "",
    passphrase: encryption.passphrase || ""
  };
}

async function vaultFiles(rootPath, currentPath) {
  const entries = await fs.readdir(currentPath, { withFileTypes: true }); // NOSONAR S2083 -- root traversal validated by caller
  const files = [];
  for (const entry of entries) {
    if (isEncryptionExcludedEntry(entry.name)) continue;
    const absolute = path.join(currentPath, entry.name);
    if (entry.isDirectory()) files.push(...await vaultFiles(rootPath, absolute));
    else if (entry.isFile()) files.push(toPosix(path.relative(rootPath, absolute)));
  }
  return files;
}

async function copyEncryptedDirectory(sourcePath, destinationPath, encryption) {
  const entries = await fs.readdir(sourcePath, { withFileTypes: true }); // NOSONAR S2083
  await fs.mkdir(destinationPath, { recursive: true }); // NOSONAR S2083
  for (const entry of entries) {
    const sourceEntryPath = path.join(sourcePath, entry.name);
    const targetEntryPath = path.join(destinationPath, entry.name);
    if (entry.isDirectory()) {
      if (encryptionExcludedDirs.has(entry.name)) continue;
      await copyEncryptedDirectory(sourceEntryPath, targetEntryPath, encryption);
    } else if (entry.isFile() && isEncryptionExcludedFileName(entry.name)) {
      await fs.copyFile(sourceEntryPath, targetEntryPath); // NOSONAR S2083
    } else if (entry.isFile()) {
      await fs.writeFile(`${targetEntryPath}.gpg`, await fileContentForDisk(await fs.readFile(sourceEntryPath), encryption)); // NOSONAR S2083
    }
  }
}

async function updateMovedReferences(rootPath, type, oldPath, newPath, encryption = {}) {
  if (type === "asset" && imageExtensions.has(path.extname(newPath).toLowerCase())) {
    await updateMovedAssetReferences(rootPath, oldPath, newPath, encryption);
  } else if (type === "note") {
    await updateMovedNoteReferences(rootPath, oldPath, newPath, encryption);
  } else if (type === "folder") {
    await updateMovedFolderReferences(rootPath, oldPath, newPath, encryption);
  }
}

async function updateMovedAssetReferences(rootPath, oldAssetPath, newAssetPath, encryption = {}) {
  const notes = flattenNotes(await readDirectory(rootPath, rootPath));
  for (const note of notes) {
    const original = await readNoteContent(rootPath, note.path, encryption);
    const updated = rewriteAssetLinks(original, note.path, oldAssetPath, newAssetPath);
    if (updated !== original) await writeNote(rootPath, note.path, updated, encryption);
  }
}

async function updateMovedNoteReferences(rootPath, oldNotePath, newNotePath, encryption = {}) {
  const notes = flattenNotes(await readDirectory(rootPath, rootPath));
  for (const note of notes) {
    const original = await readNoteContent(rootPath, note.path, encryption);
    let updated = rewriteAssetLinks(original, note.path, oldNotePath, newNotePath);
    updated = rewriteWikiNoteLinks(updated, note.path, oldNotePath, newNotePath);
    if (updated !== original) await writeNote(rootPath, note.path, updated, encryption);
  }
}

async function updateMovedFolderReferences(rootPath, oldFolderPath, newFolderPath, encryption = {}) {
  const notes = flattenNotes(await readDirectory(rootPath, rootPath));
  for (const note of notes) {
    const original = await readNoteContent(rootPath, note.path, encryption);
    let updated = rewriteFolderMarkdownLinks(original, note.path, oldFolderPath, newFolderPath);
    updated = rewriteFolderWikiLinks(updated, note.path, oldFolderPath, newFolderPath);
    if (updated !== original) await writeNote(rootPath, note.path, updated, encryption);
  }
}

function rewriteAssetLinks(markdown, notePath, oldAssetPath, newAssetPath) {
  return replaceMarkdownLinks(markdown, ({ match, prefix, href, suffix }) => {
    const decodedHref = decodeMarkdownLink(href);
    if (/^[a-z]+:\/\//i.test(decodedHref)) return match;
    if (resolveMarkdownReference(notePath, decodedHref) !== oldAssetPath) return match;
    return `${prefix}${encodeMarkdownLink(relativeMarkdownPath(notePath, newAssetPath))}${suffix}`;
  });
}

function rewriteFolderMarkdownLinks(markdown, notePath, oldFolderPath, newFolderPath) {
  return replaceMarkdownLinks(markdown, ({ match, prefix, href, suffix }) => {
    const decodedHref = decodeMarkdownLink(href);
    if (/^[a-z]+:\/\//i.test(decodedHref)) return match;
    const moved = movedPathInsideFolder(resolveMarkdownReference(notePath, decodedHref), oldFolderPath, newFolderPath);
    if (!moved) return match;
    return `${prefix}${encodeMarkdownLink(relativeMarkdownPath(notePath, moved))}${suffix}`;
  });
}

function rewriteWikiNoteLinks(markdown, notePath, oldNotePath, newNotePath) {
  return replaceWikiLinks(markdown, ({ match, target }) => {
    const pipeIndex = target.indexOf("|");
    const targetPart = pipeIndex >= 0 ? target.slice(0, pipeIndex) : target;
    const aliasPart = pipeIndex >= 0 ? target.slice(pipeIndex) : "";
    const headingIndex = targetPart.indexOf("#");
    const pathPart = headingIndex >= 0 ? targetPart.slice(0, headingIndex) : targetPart;
    const headingPart = headingIndex >= 0 ? targetPart.slice(headingIndex) : "";
    if (resolveWikiReference(notePath, pathPart) !== oldNotePath) return match;
    return `[[${wikiTargetFor(notePath, pathPart, newNotePath)}${headingPart}${aliasPart}]]`;
  });
}

function rewriteFolderWikiLinks(markdown, notePath, oldFolderPath, newFolderPath) {
  return replaceWikiLinks(markdown, ({ match, target }) => {
    const pipeIndex = target.indexOf("|");
    const targetPart = pipeIndex >= 0 ? target.slice(0, pipeIndex) : target;
    const aliasPart = pipeIndex >= 0 ? target.slice(pipeIndex) : "";
    const headingIndex = targetPart.indexOf("#");
    const pathPart = headingIndex >= 0 ? targetPart.slice(0, headingIndex) : targetPart;
    const headingPart = headingIndex >= 0 ? targetPart.slice(headingIndex) : "";
    const moved = movedPathInsideFolder(resolveWikiReference(notePath, pathPart), oldFolderPath, newFolderPath);
    if (!moved) return match;
    return `[[${wikiTargetFor(notePath, pathPart, moved)}${headingPart}${aliasPart}]]`;
  });
}

function replaceMarkdownLinks(markdown, transform) {
  let output = "";
  let index = 0;

  while (index < markdown.length) {
    const openBracket = markdown.indexOf("[", index);
    if (openBracket === -1) {
      output += markdown.slice(index);
      break;
    }

    const prefixStart = openBracket > 0 && markdown[openBracket - 1] === "!" ? openBracket - 1 : openBracket;
    const closeBracket = markdown.indexOf("]", openBracket + 1);
    if (closeBracket === -1 || markdown[closeBracket + 1] !== "(") {
      output += markdown.slice(index, openBracket + 1);
      index = openBracket + 1;
      continue;
    }

    const closeParen = markdown.indexOf(")", closeBracket + 2);
    if (closeParen === -1) {
      output += markdown.slice(index, openBracket + 1);
      index = openBracket + 1;
      continue;
    }

    const match = markdown.slice(prefixStart, closeParen + 1);
    const prefix = markdown.slice(prefixStart, closeBracket + 2);
    const href = markdown.slice(closeBracket + 2, closeParen);
    const suffix = ")";
    output += markdown.slice(index, prefixStart);
    output += transform({ match, prefix, href, suffix });
    index = closeParen + 1;
  }

  return output;
}

function replaceWikiLinks(markdown, transform) {
  let output = "";
  let index = 0;

  while (index < markdown.length) {
    const start = markdown.indexOf("[[", index);
    if (start === -1) {
      output += markdown.slice(index);
      break;
    }

    const end = markdown.indexOf("]]", start + 2);
    if (end === -1) {
      output += markdown.slice(index);
      break;
    }

    const match = markdown.slice(start, end + 2);
    output += markdown.slice(index, start);
    output += transform({ match, target: markdown.slice(start + 2, end) });
    index = end + 2;
  }

  return output;
}

function movedPathInsideFolder(resolvedPath, oldFolderPath, newFolderPath) {
  if (!resolvedPath || resolvedPath === oldFolderPath) return "";
  if (!resolvedPath.startsWith(`${oldFolderPath}/`)) return "";
  return `${newFolderPath}${resolvedPath.slice(oldFolderPath.length)}`;
}

function resolveWikiReference(notePath, target) {
  const clean = trimLeadingSlashes(decodeMarkdownLink(target).trim());
  if (!clean) return "";
  const candidates = path.extname(clean) ? [clean] : [`${clean}.md`, clean];
  for (const candidate of candidates) {
    const resolved = resolveMarkdownReference(notePath, candidate);
    if (resolved) return resolved;
  }
  return "";
}

function wikiTargetFor(notePath, oldTarget, newNotePath) {
  const relative = removeMarkdownExtension(relativeMarkdownPath(notePath, newNotePath));
  if (oldTarget.includes("/") || oldTarget.startsWith(".") || oldTarget.startsWith("/")) return trimLeadingDotSlash(relative);
  return path.basename(newNotePath, path.extname(newNotePath));
}

function resolveMarkdownReference(notePath, href) {
  const clean = stripFragment(stripWrappingAngles(href));
  const noteFolder = parentPosix(notePath);
  const joined = clean.startsWith("/") ? trimLeadingSlashes(clean) : path.posix.join(noteFolder, clean);
  return normalizePosix(joined);
}

function relativeMarkdownPath(notePath, assetPath) {
  const noteFolder = parentPosix(notePath);
  const relative = path.posix.relative(noteFolder || ".", assetPath);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function decodeMarkdownLink(value) {
  const trimmed = stripWrappingAngles(value);
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

function encodeMarkdownLink(value) {
  return encodeURI(value).replaceAll("%5B", "[").replaceAll("%5D", "]");
}

function parentPosix(value) {
  const parts = value.split("/");
  parts.pop();
  return parts.join("/");
}

function resolveVaultPath(rootPath, relativePath) {
  const normalizedRoot = path.resolve(rootPath);
  const resolved = path.resolve(normalizedRoot, normalizeRelative(relativePath));
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
    throw new Error("Requested path is outside the vault.");
  }
  return resolved;
}

function resolveVaultFilePath(rootPath, relativePath, encryption = {}) {
  const logicalPath = normalizeRelative(relativePath);
  return resolveVaultPath(rootPath, encryption.enabled && !isEncryptionExcludedFilePath(logicalPath)
    ? encryptedRelativePath(logicalPath)
    : logicalPath);
}

function encryptedRelativePath(relativePath) {
  const normalized = normalizeRelative(relativePath);
  return normalized.endsWith(".gpg") ? normalized : `${normalized}.gpg`;
}

function decryptedRelativePath(relativePath) {
  const normalized = normalizeRelative(relativePath);
  return normalized.endsWith(".gpg") ? normalized.slice(0, -4) : normalized;
}

function logicalRelativePath(relativePath, encryption = {}) {
  return encryption.enabled ? decryptedRelativePath(relativePath) : normalizeRelative(relativePath);
}

function logicalFileName(name, encryption = {}) {
  return encryption.enabled && name.endsWith(".gpg") ? name.slice(0, -4) : name;
}

function isEncryptionExcludedEntry(name) {
  return encryptionExcludedDirs.has(name) || isEncryptionExcludedFileName(name);
}

function isEncryptionExcludedFilePath(relativePath) {
  return isEncryptionExcludedFileName(path.posix.basename(normalizeRelative(relativePath)));
}

function isEncryptionExcludedFileName(name) {
  const logicalName = name.endsWith(".gpg") ? name.slice(0, -4) : name;
  return encryptionExcludedFiles.has(logicalName);
}

function assertInsideVault(rootPath, candidatePath) {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedCandidate = path.resolve(candidatePath);
  if (normalizedCandidate !== normalizedRoot && !normalizedCandidate.startsWith(normalizedRoot + path.sep)) {
    throw new Error("Requested path is outside the vault.");
  }
}

function noteTitle(relativePath) {
  return path.basename(relativePath, path.extname(relativePath));
}

function sanitizeNoteName(value) {
  return removeMarkdownExtension(sanitizeEntryName(value, "Untitled")) || "Untitled";
}

function renamedEntryName(currentName, requestedName, type) {
  if (type === "folder") return sanitizeEntryName(requestedName || currentName, currentName);

  const currentExtension = path.extname(currentName);
  const fallback = path.basename(currentName, currentExtension);
  const requested = sanitizeEntryName(requestedName || fallback, fallback);
  const requestedExtension = path.extname(requested);

  if (type === "note") return `${removeMarkdownExtension(requested) || fallback}.md`;
  if (requestedExtension && imageExtensions.has(requestedExtension.toLowerCase())) return requested;
  return `${path.basename(requested, path.extname(requested)) || fallback}${currentExtension}`;
}

function imageMimeType(extension) {
  switch (extension) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".avif":
      return "image/avif";
    default:
      return "image/png";
  }
}

function clipboardImageExtension(mimeType, requestedName = "") {
  const requestedExtension = path.extname(requestedName).toLowerCase();
  if (imageExtensions.has(requestedExtension)) return requestedExtension;
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/svg+xml":
      return ".svg";
    case "image/avif":
      return ".avif";
    default:
      return ".png";
  }
}

async function clipboardImageCandidate(rootPath, baseFolder, requestedName, extension) {
  if (hasOriginalClipboardName(requestedName)) {
    const parsed = path.parse(requestedName);
    const sourceName = sanitizeEntryName(parsed.name, "image");
    return uniqueOriginalAssetPath(rootPath, baseFolder, sourceName, extension);
  }

  const date = new Date();
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return uniqueGeneratedAssetPath(rootPath, baseFolder, `image-${yyyy}${mm}${dd}`, extension);
}

function hasOriginalClipboardName(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  return !/^image\.(png|jpe?g|gif|webp|svg|avif)$/i.test(value.trim());
}

async function uniqueOriginalAssetPath(rootPath, baseFolder, baseName, extension) {
  let candidate = path.posix.join(baseFolder, `${baseName}${extension}`);
  let index = 2;
  while (await existsAnyFilePath(rootPath, candidate)) {
    candidate = path.posix.join(baseFolder, `${baseName} ${index}${extension}`);
    index += 1;
  }
  return candidate;
}

async function uniqueGeneratedAssetPath(rootPath, baseFolder, baseName, extension) {
  let index = 1;
  let candidate = path.posix.join(baseFolder, `${baseName}-${index}${extension}`);
  while (await exists(resolveVaultPath(rootPath, candidate))) {
    index += 1;
    candidate = path.posix.join(baseFolder, `${baseName}-${index}${extension}`);
  }
  return candidate;
}

function sanitizeEntryName(value, fallback) {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .trim() || fallback;
}

function normalizeRelative(value) {
  return normalizePosix(trimLeadingSlashes(toPosix(value || "")));
}

function normalizePosix(value) {
  const parts = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

async function exists(filePath) {
  try {
    await fs.access(filePath); // NOSONAR S2083 -- all callers pass resolveVaultPath result
    return true;
  } catch {
    return false;
  }
}

async function existsAnyFilePath(rootPath, relativePath) {
  if (isEncryptionExcludedFilePath(relativePath)) return exists(resolveVaultPath(rootPath, relativePath));
  return await exists(resolveVaultPath(rootPath, relativePath)) || await exists(resolveVaultPath(rootPath, encryptedRelativePath(relativePath)));
}

function assertEntryType(stat, type) {
  if (type === "folder" && !stat.isDirectory()) throw new Error("Selected entry is not a folder.");
  if ((type === "note" || type === "asset") && !stat.isFile()) throw new Error("Selected entry is not a file.");
}

function assetPayload(candidate) {
  return {
    path: candidate,
    name: path.basename(candidate),
    label: path.basename(candidate, path.extname(candidate))
  };
}

function trimSlashes(value) {
  return trimTrailingSlashes(trimLeadingSlashes(value));
}

function trimLeadingSlashes(value) {
  let index = 0;
  while (value[index] === "/") index += 1;
  return value.slice(index);
}

function trimTrailingSlashes(value) {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

function trimLeadingDotSlash(value) {
  return value.startsWith("./") ? value.slice(2) : value;
}

function stripWrappingAngles(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) return trimmed.slice(1, -1);
  return trimmed;
}

function stripFragment(value) {
  const index = value.indexOf("#");
  return index >= 0 ? value.slice(0, index) : value;
}

function removeMarkdownExtension(value) {
  return value.toLowerCase().endsWith(".md") ? value.slice(0, -3) : value;
}

module.exports = {
  assertInsideVault,
  createFolder,
  createNote,
  deleteEntry,
  flattenNotes,
  importFileOrDirectory,
  importImage,
  listTemplates,
  loadSettings,
  moveEntry,
  noteModifiedTimes,
  readAssetDataUrl,
  readNote,
  renameEntry,
  resolveVaultPath,
  saveClipboardImage,
  saveSettings,
  scanVault,
  validateVaultRoot,
  writeNote
};
