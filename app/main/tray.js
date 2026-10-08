'use strict';
/**
 * 系统托盘：关闭主窗口时缩进托盘继续在后台运行（SnowLuma / AstrBot 不掉线）。
 *
 * 设计要点：
 *  - 图标内联成 base64（app/main/tray-icon.js），打包成 asar 后依然可用；
 *  - 菜单在每次右键时现场构建（buildMenu 回调），因此能显示最新的服务状态；
 *  - 左键单击 = 显示/隐藏主窗口，双击 = 显示；
 *  - 首次缩进托盘时用气泡提示一次，告诉用户怎么找回窗口和怎么真正退出。
 */
const { Tray, Menu, nativeImage } = require('electron');
const { TRAY_ICON_PNG_BASE64 } = require('./tray-icon');

let tray = null;

function trayImage() {
  const image = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_PNG_BASE64}`);
  return image.isEmpty() ? nativeImage.createEmpty() : image;
}

/**
 * @param {{buildMenu:Function, onToggle:Function, onShow:Function}} handlers
 */
function createTray({ buildMenu, onToggle, onShow }) {
  if (tray) return tray;
  try {
    tray = new Tray(trayImage());
  } catch (error) {
    console.error(`[tray] 创建失败：${error.message}`);
    tray = null;
    return null;
  }

  tray.setToolTip('SnowLuma × AstrBot 控制台');
  tray.on('click', () => { try { onToggle(); } catch { /* ignore */ } });
  tray.on('double-click', () => { try { onShow(); } catch { /* ignore */ } });
  tray.on('right-click', () => {
    try {
      tray.popUpContextMenu(Menu.buildFromTemplate(buildMenu()));
    } catch (error) {
      console.error(`[tray] 菜单弹出失败：${error.message}`);
    }
  });

  // 非 Windows 平台右键不会自动触发 popUpContextMenu，这里兜底设置一个静态菜单
  if (process.platform !== 'win32') {
    try {
      tray.setContextMenu(Menu.buildFromTemplate(buildMenu()));
    } catch { /* ignore */ }
  }
  return tray;
}

function trayExists() {
  return Boolean(tray) && !tray.isDestroyed();
}

function setTooltip(text) {
  if (trayExists()) tray.setToolTip(text);
}

/** Windows 气泡通知（其它平台忽略）。 */
function notify(title, content) {
  if (!trayExists()) return false;
  try {
    tray.displayBalloon({ title, content, iconType: 'info' });
    return true;
  } catch {
    return false;
  }
}

function destroyTray() {
  if (trayExists()) {
    try { tray.destroy(); } catch { /* ignore */ }
  }
  tray = null;
}

module.exports = { createTray, trayExists, setTooltip, notify, destroyTray };
