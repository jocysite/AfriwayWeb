const { app, BrowserWindow, dialog } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const net = require("net");

let mainWindow = null;
let flaskProcess = null;
let FLASK_PORT = null;

/**
 * Afriway Downloader — Electron Main Process
 * Proudly African desktop application
 * Inspired by the colours of Ethiopia and Pan-African spirit
 */

/**
 * Find a free port by trying ports starting from 5000
 */
function findFreePort(start = 5000) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(start, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", () => {
      // Port in use, try next
      resolve(findFreePort(start + 1));
    });
  });
}

/**
 * Get the path to the Python executable
 */
function getPythonPath() {
  // Try python first, then python3
  const isWin = process.platform === "win32";
  if (isWin) {
    return "python";
  }
  return "python3";
}

/**
 * Get the path to the app directory (handles both dev and packaged)
 */
function getAppPath() {
  if (app.isPackaged) {
    // In packaged mode, files are in extraResources
    return path.join(process.resourcesPath, "app");
  }
  // In development mode, use current directory
  return __dirname;
}

/**
 * Start the Flask backend server
 */
async function startFlask() {
  FLASK_PORT = await findFreePort();
  const appPath = getAppPath();
  const scriptPath = path.join(appPath, "app.py");

  console.log(`[Main] Starting Flask backend on port ${FLASK_PORT}...`);
  console.log(`[Main] App path: ${appPath}`);
  console.log(`[Main] Script path: ${scriptPath}`);

  const pythonPath = getPythonPath();

  flaskProcess = spawn(pythonPath, [scriptPath], {
    cwd: appPath,
    env: {
      ...process.env,
      FLASK_PORT: String(FLASK_PORT),
      FLASK_DEBUG: "0",
      PYTHONUNBUFFERED: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  flaskProcess.stdout.on("data", (data) => {
    const output = data.toString();
    console.log(`[Flask] ${output.trim()}`);
  });

  flaskProcess.stderr.on("data", (data) => {
    const output = data.toString();
    console.log(`[Flask] ${output.trim()}`);
  });

  flaskProcess.on("error", (err) => {
    console.error(`[Main] Failed to start Flask: ${err.message}`);
    dialog.showErrorBox(
      "Application Error",
      `Failed to start the backend server.\n\nMake sure Python is installed and the required packages are installed:\n\n  pip install flask yt_dlp\n\nError: ${err.message}`
    );
    app.quit();
  });

  flaskProcess.on("close", (code) => {
    console.log(`[Main] Flask process exited with code ${code}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }
  });

  // Wait for Flask to be ready
  await waitForFlask();
}

/**
 * Wait for the Flask server to be ready by polling the URL
 */
function waitForFlask(maxRetries = 30, delay = 500) {
  return new Promise((resolve, reject) => {
    const http = require("http");
    let retries = 0;

    const check = () => {
      retries++;
      const req = http.get(`http://127.0.0.1:${FLASK_PORT}/`, (res) => {
        console.log(`[Main] Flask server is ready (attempt ${retries})`);
        resolve();
      });

      req.on("error", () => {
        if (retries >= maxRetries) {
          reject(new Error("Flask server failed to start within timeout"));
          return;
        }
        setTimeout(check, delay);
      });

      req.setTimeout(2000, () => {
        req.destroy();
        if (retries >= maxRetries) {
          reject(new Error("Flask server timed out"));
          return;
        }
        setTimeout(check, delay);
      });
    };

    check();
  });
}

/**
 * Create the main application window
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Afriway Downloader",
    backgroundColor: "#0d0a08",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  // Load the Flask app
  mainWindow.loadURL(`http://127.0.0.1:${FLASK_PORT}/`);

  // Show window when ready
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  // Set window title
  mainWindow.on("page-title-updated", (event) => {
    event.preventDefault();
  });

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) {
      require("electron").shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/**
 * Application lifecycle
 */
app.whenReady().then(async () => {
  try {
    await startFlask();
    createWindow();
  } catch (err) {
    console.error(`[Main] Error during startup: ${err.message}`);
    dialog.showErrorBox(
      "Startup Error",
      `Failed to start the application.\n\n${err.message}`
    );
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  // Kill the Flask process
  if (flaskProcess) {
    console.log("[Main] Stopping Flask backend...");
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(flaskProcess.pid), "/f", "/t"]);
    } else {
      flaskProcess.kill("SIGTERM");
    }
    flaskProcess = null;
  }
});