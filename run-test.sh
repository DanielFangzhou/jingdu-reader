#!/bin/sh
# 自动化测试入口：先清理残留进程与数据，再运行 Electron 自测
set -u
cd "$(dirname "$0")" || exit 1

# 1) 结束残留实例
taskkill //F //IM electron.exe >/dev/null 2>&1
sleep 1

# 2) 数据目录改名备份（避免 bulk delete 策略拦截）
if [ -z "${KEEP_DATA:-}" ] && [ -d user-data ]; then
  mv user-data "../tmpdl/ud-$(date +%s)" 2>/dev/null || true
fi

# 3) 运行
BOOKS="${TEST_BOOKS:-}"
env -u ELECTRON_RUN_AS_NODE TEST_BOOKS="$BOOKS" \
  ./node_modules/electron/dist/electron.exe . --autotest ${EXTRA_ARGS:-} 2>&1
echo "EXIT=$?"
