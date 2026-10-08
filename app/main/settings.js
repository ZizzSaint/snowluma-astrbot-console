'use strict';
/** 启动器配置与目录布局。所有可写数据都集中在 dataRoot 下，方便迁移/备份。 */
const fs = require('fs');
const path = require('path');
const { ensureDir, readJson, writeJsonAtomic } = require('./util');

const DEFAULT_MIRRORS = ['https://ghproxy.net/', 'https://gh-proxy.com/', 'https://ghfast.top/'];
const DEFAULT_PIP_INDEXES = [
  'https://pypi.tuna.tsinghua.edu.cn/simple',
  'https://mirrors.aliyun.com/pypi/simple',
  'https://pypi.org/simple',
];

const DEFAULT_SETTINGS = {
  dataRoot: '',
  mirrors: {
    enabled: true,
    list: DEFAULT_MIRRORS.slice(),
    custom: '',
  },
  ports: {
    snowlumaWebui: 5099,
    snowlumaHttp: 3000,
    snowlumaWs: 3001,
    astrbotWebui: 6185,
    astrbotReverseWs: 6199,
  },
  pip: {
    index: DEFAULT_PIP_INDEXES[0],
    indexes: DEFAULT_PIP_INDEXES.slice(),
  },
  python: {
    launcher: '',   // 例如 py -3.13（字符串形式保存，便于跨机器迁移）
    version: '',
  },
  install: {
    snowlumaFlavor: 'auto',   // auto | lite | full
    snowlumaTag: '',          // 空 = 最新
    astrbotChannel: 'stable', // stable | prerelease
    astrbotTag: '',
  },
  runtime: {
    autostartOnLaunch: true,
    restartOnUpdate: true,
  },
  secrets: {
    snowlumaPassword: '',     // 首次启动时由启动器预置 / 或从日志抓取
    astrbotPassword: '',      // 首次启动前预置到 cmd_config.json，之后一直复用
  },
  ui: {
    lastPage: 'home',
    confirmStop: true,
    closeToTray: true,        // 关闭窗口时缩进托盘（服务继续后台运行）
    trayNoticeShown: false,   // 是否已提示过"已缩进托盘"
  },
};

function layout(root) {
  const apps = path.join(root, 'apps');
  const instances = path.join(root, 'instances');
  return {
    root,
    logs: path.join(root, 'logs'),
    downloads: path.join(root, 'downloads'),
    state: path.join(root, 'state'),
    apps,
    instances,
    app: {
      snowluma: path.join(apps, 'SnowLuma'),
      astrbot: path.join(apps, 'AstrBot'),
    },
    instance: {
      snowluma: path.join(instances, 'SnowLuma'),
      astrbot: path.join(instances, 'AstrBot'),
    },
    meta: {
      snowluma: path.join(root, 'state', 'snowluma.json'),
      astrbot: path.join(root, 'state', 'astrbot.json'),
    },
  };
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

class Store {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.file = path.join(baseDir, 'settings.json');
    this.data = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }

  load() {
    const raw = readJson(this.file, null);
    if (raw && typeof raw === 'object') {
      this.data = deepMerge(this.data, raw);
    }
    if (!this.data.dataRoot) this.data.dataRoot = path.join(this.baseDir, 'data');
    return this.data;
  }

  async save() {
    await ensureDir(this.baseDir);
    await writeJsonAtomic(this.file, this.data);
  }

  get() {
    return this.data;
  }

  async patch(patch) {
    this.data = deepMerge(this.data, patch);
    if (this.data.mirrors.custom && !this.data.mirrors.list.includes(this.data.mirrors.custom)) {
      this.data.mirrors.list = [this.data.mirrors.custom, ...this.data.mirrors.list.filter((m) => m !== this.data.mirrors.custom)];
    }
    await this.save();
    return this.data;
  }

  layout() {
    return layout(this.data.dataRoot);
  }

  async ensureLayout() {
    const l = this.layout();
    for (const dir of [l.root, l.logs, l.downloads, l.state, l.apps, l.instances, l.instance.snowluma, l.instance.astrbot]) {
      await ensureDir(dir);
    }
    return l;
  }

  /** 生效的镜像前缀列表（直连永远优先）。 */
  mirrorPrefixes() {
    if (!this.data.mirrors.enabled) return [];
    const list = [];
    if (this.data.mirrors.custom) list.push(this.data.mirrors.custom);
    for (const m of this.data.mirrors.list) {
      if (m && !list.includes(m)) list.push(m);
    }
    return list.map((m) => (m.endsWith('/') ? m : `${m}/`));
  }
}

module.exports = { Store, layout, DEFAULT_SETTINGS, DEFAULT_MIRRORS, DEFAULT_PIP_INDEXES };
