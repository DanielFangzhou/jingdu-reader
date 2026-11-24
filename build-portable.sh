#!/bin/sh
# 生成免安装绿色版：dist/静读/
set -eu
cd "$(dirname "$0")"

DIST="../dist"
OUT="$DIST/静读"
ELEC="node_modules/electron/dist"

if [ ! -d "$ELEC" ]; then
  echo "缺少 Electron 运行时，请先 npm install" >&2
  exit 1
fi

if [ -d "$OUT" ]; then
  mv "$OUT" "$DIST/静读-old-$(date +%s)" 2>/dev/null || true
fi
mkdir -p "$OUT/resources/app"

# 1) 复制运行时
cp -r "$ELEC"/. "$OUT"/
mv "$OUT/electron.exe" "$OUT/静读.exe"
rm -f "$OUT/resources/default_app.asar"
# 只保留中英文语言包，减小体积
if [ -d "$OUT/locales" ]; then
  find "$OUT/locales" -maxdepth 1 -type f ! -name 'zh-CN.pak' ! -name 'en-US.pak' -delete
fi

# 2) 复制应用代码
cp main.js preload.js package.json "$OUT/resources/app/"
cp -r app assets "$OUT/resources/app/"

# 3) 应用内 package.json 去掉开发依赖
cat > "$OUT/resources/app/package.json" <<'JSON'
{
  "name": "jingdu-reader",
  "productName": "静读",
  "version": "1.0.0",
  "description": "静读 · 本地离线电子书阅读器",
  "main": "main.js",
  "private": true,
  "license": "MIT"
}
JSON

# 4) 首次运行的说明文件
cat > "$OUT/使用说明.txt" <<'TXT'
静读 · 本地电子书阅读器
========================

启动：双击「静读.exe」
支持格式：EPUB / MOBI / AZW3 / AZW / PDF / TXT / FB2 / CBZ

【隐身说明】
· 程序不会出现在任务栏，也不会出现在 Alt+Tab 切换列表里。
· 关闭按钮（右上角 ×）默认只是隐藏到托盘，不会退出。
· 全局热键 Ctrl+Alt+B：一键隐藏 / 唤出窗口（可在「排版 → 窗口与隐蔽」里改）。
· Ctrl+Alt+H：直接隐藏。
· 右下角托盘图标：单击唤出 / 隐藏，右键可退出、置顶。
· 彻底退出：托盘右键 →「退出（彻底关闭）」，或在设置里打开「关闭即退出」。
· 可选「自动隐藏」：鼠标离开窗口 N 秒后自动隐藏。

【数据位置】
所有书籍、书签、笔记、阅读进度都保存在本目录的 user-data 文件夹里。
整个文件夹可以直接复制到 U 盘或另一台电脑，进度跟着走。
删除本文件夹即为卸载，不写注册表、不装服务。

【滚轮翻页】
分页模式下：鼠标滚轮向下翻一页、向上翻前一页（滚动模式下为正常连续滚动）。
PDF 为连续滚动视图，滚轮、方向键、PageDown 均可滚动/翻页，Ctrl+滚轮可缩放。

【快捷键】
空格 / PageDown / →   下一页          PageUp / ←   上一页
滚轮上 / 下           上一页 / 下一页（分页模式）
Ctrl + ← / →          跳章节          Ctrl + D     加书签
Ctrl + F              搜索            Ctrl + ,     排版设置
Ctrl + 0 / + / -      字号缩放（PDF 为页面缩放）  Esc  关闭面板 / 回到书架
Ctrl + W              隐藏窗口        F11          全屏
TXT 会自动识别「第X章」并生成目录，编码支持 UTF-8 / GBK。
PDF 会读取文件自带书签作为目录（没有书签时按页生成），并取其首页作为封面。
TXT

echo "完成：$OUT"
du -sh "$OUT"
