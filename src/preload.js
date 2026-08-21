const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("tektite", {
  chooseVault: () => ipcRenderer.invoke("vault:choose"),
  scanVault: (rootPath) => ipcRenderer.invoke("vault:scan", rootPath),
  readNote: (rootPath, relativePath, encryption) => ipcRenderer.invoke("note:read", rootPath, relativePath, encryption),
  getNoteModifiedTimes: (rootPath, relativePaths) =>
    ipcRenderer.invoke("notes:modified-times", rootPath, relativePaths),
  writeNote: (rootPath, relativePath, content, encryption) =>
    ipcRenderer.invoke("note:write", rootPath, relativePath, content, encryption),
  createNote: (rootPath, requestedName, folder, templatePath, encryption) =>
    ipcRenderer.invoke("note:create", rootPath, requestedName, folder, templatePath, encryption),
  listTemplates: (rootPath, templatesPath) => ipcRenderer.invoke("templates:list", rootPath, templatesPath),
  loadSettings: (rootPath) => ipcRenderer.invoke("settings:load", rootPath),
  saveSettings: (rootPath, settings, encryption) => ipcRenderer.invoke("settings:save", rootPath, settings, encryption),
  createFolder: (rootPath, requestedName, parentFolder) =>
    ipcRenderer.invoke("folder:create", rootPath, requestedName, parentFolder),
  deleteEntry: (rootPath, relativePath, type) =>
    ipcRenderer.invoke("entry:delete", rootPath, relativePath, type),
  renameEntry: (rootPath, relativePath, type, requestedName, encryption) =>
    ipcRenderer.invoke("entry:rename", rootPath, relativePath, type, requestedName, encryption),
  moveEntry: (rootPath, relativePath, type, targetFolder, encryption) =>
    ipcRenderer.invoke("entry:move", rootPath, relativePath, type, targetFolder, encryption),
  importImage: (rootPath, sourcePath, targetFolder) =>
    ipcRenderer.invoke("asset:import-image", rootPath, sourcePath, targetFolder),
  importFile: (rootPath, sourcePath, targetFolder, encryption) =>
    ipcRenderer.invoke("asset:import-file-or-directory", rootPath, sourcePath, targetFolder, encryption),
  saveClipboardImage: (rootPath, targetFolder, image) =>
    ipcRenderer.invoke("asset:save-clipboard-image", rootPath, targetFolder, image),
  readAssetDataUrl: (rootPath, relativePath, encryption) =>
    ipcRenderer.invoke("asset:read-data-url", rootPath, relativePath, encryption),
  setVaultWindowTitle: (vaultName, gitUrl) => ipcRenderer.invoke("window:set-vault-name", vaultName, gitUrl),
  printPreview: (payload) => ipcRenderer.invoke("preview:print", payload),
  syncGit: (rootPath) => ipcRenderer.invoke("git:sync", rootPath),
  loadWorkspaceState: (rootPath) => ipcRenderer.invoke("workspace:load", rootPath),
  saveWorkspaceState: (rootPath, workspace) => ipcRenderer.invoke("workspace:save", rootPath, workspace),
  registerWindow: () => ipcRenderer.invoke("window:register"),
  getFilePath: (file) => webUtils.getPathForFile(file),
  onOpenVault: (callback) => ipcRenderer.on("menu:open-vault", callback),
  onOpenRecentVault: (callback) =>
    ipcRenderer.on("menu:open-recent-vault", (_event, rootPath) => callback(rootPath)),
  onNewNote: (callback) => ipcRenderer.on("menu:new-note", callback),
  onNewFolder: (callback) => ipcRenderer.on("menu:new-folder", callback),
  onCloseTab: (callback) => ipcRenderer.on("menu:close-tab", callback),
  onCloseAllTabs: (callback) => ipcRenderer.on("menu:close-all-tabs", callback),
  onPrintPreview: (callback) => ipcRenderer.on("menu:print-preview", callback),
  onRefreshVault: (callback) => ipcRenderer.on("menu:refresh-vault", callback),
  onToggleFileSuffixes: (callback) => ipcRenderer.on("menu:toggle-file-suffixes", callback),
  onToggleTheme: (callback) => ipcRenderer.on("menu:toggle-theme", callback),
  setPaneState: (paneState) => ipcRenderer.invoke("window:pane-state", paneState),
  onToggleEditorPane: (callback) => ipcRenderer.on("menu:toggle-editor-pane", callback),
  onTogglePreviewPane: (callback) => ipcRenderer.on("menu:toggle-preview-pane", callback),
  onToggleTagsPane: (callback) => ipcRenderer.on("menu:toggle-tags-pane", callback),
  onToggleGraphPane: (callback) => ipcRenderer.on("menu:toggle-graph-pane", callback),
  onToggleTerminalPane: (callback) => ipcRenderer.on("menu:toggle-terminal-pane", callback),
  onToggleLineNumbers: (callback) => ipcRenderer.on("menu:toggle-line-numbers", callback),
  terminalCreate: (cwd, cols, rows) => ipcRenderer.invoke("terminal:create", cwd, cols, rows),
  terminalWrite: (pid, data) => ipcRenderer.invoke("terminal:write", pid, data),
  terminalResize: (pid, cols, rows) => ipcRenderer.invoke("terminal:resize", pid, cols, rows),
  terminalDestroy: (pid) => ipcRenderer.invoke("terminal:destroy", pid),
  onTerminalKill: (callback) => {
    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on("terminal:kill", listener);
    return () => ipcRenderer.removeListener("terminal:kill", listener);
  },
  onTerminalData: (pid, cb) => {
    const ch = `terminal:data:${pid}`;
    const fn = (_e, d) => cb(d);
    ipcRenderer.on(ch, fn);
    return () => ipcRenderer.removeListener(ch, fn);
  },
  onOpenSettings: (callback) => ipcRenderer.on("menu:open-settings", callback),
  onGitSyncOutput: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("git:sync-output", listener);
    return () => ipcRenderer.removeListener("git:sync-output", listener);
  }
});
